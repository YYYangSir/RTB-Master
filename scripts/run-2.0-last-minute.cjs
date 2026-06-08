const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { setTimeout: sleep } = require('node:timers/promises');
const { io } = require('../apps/user-web/node_modules/socket.io-client');

const base = 'http://127.0.0.1:3000';
const api = `${base}/api`;
const reportDir = 'reports';
mkdirSync(reportDir, { recursive: true });

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));

const caseId = args.get('case') ?? 'TC-MIX-002';
const users = Number(args.get('users') ?? 100);
const activeBidders = Number(args.get('bidders') ?? 30);
const minutes = Number(args.get('minutes') ?? 3);
const durationSec = minutes * 60;
const incrementCent = 100;
const capPriceCent = 5000;
const extensionWindowSec = 10;
const extensionSec = 20;

function authHeaders(user) {
  return { Authorization: `Bearer ${user.token}` };
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

async function request(path, { method = 'GET', body, headers } = {}) {
  const started = performance.now();
  const response = await fetch(`${api}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    ok: response.ok,
    status: response.status,
    latencyMs: performance.now() - started,
    data: await response.json().catch(() => ({})),
  };
}

async function must(path, options) {
  const result = await request(path, options);
  if (!result.ok) throw new Error(`${path} ${result.status} ${JSON.stringify(result.data)}`);
  return result.data;
}

async function healthOk() {
  try {
    return (await request('/health')).ok;
  } catch {
    return false;
  }
}

async function waitForHealth() {
  for (let i = 0; i < 60; i += 1) {
    if (await healthOk()) return;
    await sleep(500);
  }
  throw new Error('API did not become healthy');
}

async function login(nickname, role) {
  const result = await must('/auth/login', { method: 'POST', body: { nickname, role } });
  return { ...result.user, token: result.token };
}

async function setupAuction(admin) {
  const stamp = Date.now();
  const product = await must('/products', {
    method: 'POST',
    headers: authHeaders(admin),
    body: { name: `2.0 最后抢价拍品 ${stamp}`, description: `${caseId} 自动化测试拍品` },
  });
  const room = await must('/live-rooms', {
    method: 'POST',
    headers: authHeaders(admin),
    body: { title: `2.0 最后抢价直播间 ${stamp}` },
  });
  const auction = await must('/auctions', {
    method: 'POST',
    headers: authHeaders(admin),
    body: {
      productId: product.id,
      liveRoomId: room.id,
      startPriceCent: 0,
      incrementCent,
      capPriceCent,
      durationSec,
      extensionWindowSec,
      extensionSec,
    },
  });
  await must(`/auctions/${auction.id}/start`, { method: 'POST', headers: authHeaders(admin) });
  return auction;
}

async function connectClient(auctionId, user, index, metrics) {
  const socket = io(base, { transports: ['websocket'], reconnection: false, timeout: 10000 });
  socket.on('bidAccepted', (payload) => {
    metrics.bidAcceptedEvents += 1;
    if (typeof payload?.serverTime === 'number') {
      metrics.broadcastLatencies.push(Math.max(0, Date.now() - payload.serverTime));
    }
    const lastPrice = metrics.lastSeenPriceBySocket[index] ?? 0;
    if (payload?.currentPriceCent < lastPrice) metrics.priceRollbackCount += 1;
    metrics.lastSeenPriceBySocket[index] = payload?.currentPriceCent ?? lastPrice;
    metrics.latestPriceCent = Math.max(metrics.latestPriceCent, payload?.currentPriceCent ?? 0);
    metrics.latestLeaderUserId = payload?.leaderUserId ?? metrics.latestLeaderUserId;
    if (payload?.endAt) metrics.latestEndAt = payload.endAt;
  });
  socket.on('auctionExtended', (payload) => {
    metrics.extensionBroadcasts += 1;
    if (typeof payload?.serverTime === 'number') {
      metrics.broadcastLatencies.push(Math.max(0, Date.now() - payload.serverTime));
    }
    if (payload?.endAt) metrics.latestEndAt = payload.endAt;
  });
  socket.on('auctionEnded', (payload) => {
    metrics.auctionEndedEvents += 1;
    metrics.latestStatus = payload?.status ?? metrics.latestStatus;
  });
  socket.on('disconnect', () => {
    metrics.disconnects += 1;
  });
  await new Promise((resolve) => {
    socket.once('connect', resolve);
    socket.once('connect_error', resolve);
  });
  if (!socket.connected) return { socket, connected: false, snapshot: false };
  const snapshot = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 3000);
    socket.once('auctionSnapshot', (payload) => {
      clearTimeout(timer);
      metrics.latestPriceCent = Math.max(metrics.latestPriceCent, payload?.currentPriceCent ?? 0);
      metrics.latestLeaderUserId = payload?.leaderUserId ?? metrics.latestLeaderUserId;
      metrics.latestEndAt = payload?.endAt ?? metrics.latestEndAt;
      resolve(true);
    });
    socket.emit('joinAuction', { auctionId, userId: user.id, token: user.token });
  });
  return { socket, connected: true, snapshot };
}

async function bid(auctionId, user, metrics) {
  const detail = await request(`/auctions/${auctionId}`);
  if (detail.ok) {
    metrics.latestPriceCent = Math.max(metrics.latestPriceCent, detail.data.currentPriceCent ?? 0);
    metrics.latestLeaderUserId = detail.data.leaderUserId ?? metrics.latestLeaderUserId;
    metrics.latestEndAt = detail.data.endAt ?? metrics.latestEndAt;
  }
  const beforeEndAt = metrics.latestEndAt;
  const beforeRemainingMs = beforeEndAt ? new Date(beforeEndAt).getTime() - Date.now() : null;
  const result = await request(`/auctions/${auctionId}/bids`, {
    method: 'POST',
    headers: authHeaders(user),
    body: {
      requestId: randomUUID(),
      userId: user.id,
      amountCent: metrics.latestPriceCent + incrementCent,
    },
  });
  metrics.bidLatencies.push(result.latencyMs);
  metrics.totalBidAttempts += 1;
  if (result.status >= 500) metrics.systemErrors += 1;
  if (!result.ok) {
    metrics.rejectedBids += 1;
    const message = String(result.data?.message ?? result.data?.error ?? result.status);
    metrics.businessErrors[message] = (metrics.businessErrors[message] ?? 0) + 1;
    return result;
  }
  metrics.acceptedBids += 1;
  const snapshot = result.data.snapshot ?? result.data.auction ?? result.data;
  metrics.latestPriceCent = Math.max(metrics.latestPriceCent, snapshot.currentPriceCent ?? 0);
  metrics.latestLeaderUserId = snapshot.leaderUserId ?? metrics.latestLeaderUserId;
  const afterEndAt = snapshot.endAt;
  if (result.data.extended) {
    metrics.acceptedExtensions += 1;
    metrics.extensionRecords.push({
      beforeEndAt,
      afterEndAt,
      beforeRemainingMs,
      deltaMs: beforeEndAt && afterEndAt
        ? new Date(afterEndAt).getTime() - new Date(beforeEndAt).getTime()
        : null,
      amountCent: result.data.currentPriceCent,
      bidderId: user.id,
    });
  }
  return result;
}

async function waitUntilRemaining(endAt, targetRemainingMs) {
  while (new Date(endAt).getTime() - Date.now() > targetRemainingMs) {
    await sleep(Math.min(2000, new Date(endAt).getTime() - Date.now() - targetRemainingMs));
  }
}

async function waitForFinished(auctionId, maxWaitMs) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const detail = await must(`/auctions/${auctionId}`);
    if (detail.status !== 'RUNNING') return detail;
    await sleep(500);
  }
  return must(`/auctions/${auctionId}`);
}

async function main() {
  const apiWasRunning = await healthOk();
  const apiProcess = apiWasRunning
    ? null
    : spawn('pnpm', ['--filter', 'api-server', 'exec', 'node', 'dist/main.js'], {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['ignore', 'ignore', 'ignore'],
      });

  const metrics = {
    latestPriceCent: 0,
    latestLeaderUserId: null,
    latestEndAt: null,
    latestStatus: 'RUNNING',
    totalBidAttempts: 0,
    acceptedBids: 0,
    rejectedBids: 0,
    systemErrors: 0,
    businessErrors: {},
    bidLatencies: [],
    broadcastLatencies: [],
    bidAcceptedEvents: 0,
    extensionBroadcasts: 0,
    acceptedExtensions: 0,
    extensionRecords: [],
    auctionEndedEvents: 0,
    priceRollbackCount: 0,
    lastSeenPriceBySocket: {},
    disconnects: 0,
  };
  let clients = [];

  try {
    await waitForHealth();
    const admin = await login(`2.0 ${caseId} 主播`, 'ADMIN');
    const allUsers = [];
    for (let i = 0; i < users; i += 1) {
      allUsers.push(await login(`2.0 ${caseId} 用户 ${String(i + 1).padStart(3, '0')}`, 'BIDDER'));
    }
    const auction = await setupAuction(admin);
    const connected = await Promise.all(allUsers.map((user, index) => connectClient(
      auction.id,
      user,
      index,
      metrics,
    )));
    clients = connected.map((item) => item.socket);
    const connectedCount = connected.filter((item) => item.connected).length;
    const snapshotCount = connected.filter((item) => item.snapshot).length;
    const bidders = allUsers.slice(0, activeBidders);

    await waitUntilRemaining(metrics.latestEndAt, 60_000);
    for (let i = 0; i < 8; i += 1) {
      await bid(auction.id, bidders[i % bidders.length], metrics);
      await sleep(2500);
    }

    await waitUntilRemaining(metrics.latestEndAt, 9000);
    let cursor = 8;
    while (metrics.latestPriceCent < capPriceCent && metrics.latestStatus === 'RUNNING') {
      await bid(auction.id, bidders[cursor % bidders.length], metrics);
      cursor += 1;
      await sleep(150);
    }

    const finalDetail = await waitForFinished(auction.id, 60_000);
    const afterEndResults = await Promise.all(bidders.slice(0, 10).map((user) => request(`/auctions/${auction.id}/bids`, {
      method: 'POST',
      headers: authHeaders(user),
      body: {
        requestId: randomUUID(),
        userId: user.id,
        amountCent: capPriceCent + incrementCent,
      },
    })));
    const afterEndSuccess = afterEndResults.filter((item) => item.ok).length;
    const leaderboard = await must(`/auctions/${auction.id}/leaderboard`);
    const top = leaderboard.leaderboard?.[0] ?? null;
    const order = finalDetail.order ?? null;
    const expectedExtensionBroadcasts = metrics.acceptedExtensions * connectedCount;
    const extensionBroadcastArrivalRate = expectedExtensionBroadcasts === 0
      ? 0
      : metrics.extensionBroadcasts / expectedExtensionBroadcasts;
    const extensionSuccessRate = metrics.acceptedExtensions === 0
      ? 0
      : metrics.extensionRecords.filter((item) => item.deltaMs === extensionSec * 1000).length / metrics.acceptedExtensions;
    const connectionSuccessRate = users === 0 ? 0 : connectedCount / users;
    const consistencyOk = Boolean(
      finalDetail.status === 'SOLD' &&
      order &&
      top &&
      finalDetail.currentPriceCent === top.amountCent &&
      finalDetail.currentPriceCent === order.amountCent &&
      finalDetail.leaderUserId === top.userId &&
      finalDetail.leaderUserId === order.winnerUserId,
    );

    const result = {
      caseId,
      status: (
        connectionSuccessRate >= 0.99 &&
        metrics.acceptedExtensions > 0 &&
        extensionSuccessRate === 1 &&
        extensionBroadcastArrivalRate >= 0.98 &&
        percentile(metrics.broadcastLatencies, 0.95) <= 1000 &&
        metrics.priceRollbackCount === 0 &&
        afterEndSuccess === 0 &&
        metrics.systemErrors === 0 &&
        consistencyOk
      ) ? 'PASS' : 'FAIL',
      generatedAt: new Date().toISOString(),
      users,
      activeBidders,
      minutes,
      auctionId: auction.id,
      apiWasRunning,
      connectedCount,
      snapshotCount,
      connectionSuccessRate: Number(connectionSuccessRate.toFixed(4)),
      totalBidAttempts: metrics.totalBidAttempts,
      acceptedBids: metrics.acceptedBids,
      rejectedBids: metrics.rejectedBids,
      systemErrors: metrics.systemErrors,
      businessErrors: metrics.businessErrors,
      bidP95Ms: Number(percentile(metrics.bidLatencies, 0.95).toFixed(2)),
      bidMaxMs: Number(Math.max(0, ...metrics.bidLatencies).toFixed(2)),
      bidAcceptedEvents: metrics.bidAcceptedEvents,
      acceptedExtensions: metrics.acceptedExtensions,
      extensionRecords: metrics.extensionRecords,
      expectedExtensionBroadcasts,
      extensionBroadcasts: metrics.extensionBroadcasts,
      extensionBroadcastArrivalRate: Number(extensionBroadcastArrivalRate.toFixed(4)),
      extensionSuccessRate: Number(extensionSuccessRate.toFixed(4)),
      broadcastP95Ms: Number(percentile(metrics.broadcastLatencies, 0.95).toFixed(2)),
      broadcastMaxMs: Number(Math.max(0, ...metrics.broadcastLatencies).toFixed(2)),
      auctionEndedEvents: metrics.auctionEndedEvents,
      priceRollbackCount: metrics.priceRollbackCount,
      afterEndBidAttempts: afterEndResults.length,
      afterEndSuccess,
      finalStatus: finalDetail.status,
      finalCurrentPriceCent: finalDetail.currentPriceCent,
      finalLeaderUserId: finalDetail.leaderUserId,
      orderId: order?.id ?? null,
      orderAmountCent: order?.amountCent ?? null,
      orderWinnerUserId: order?.winnerUserId ?? null,
      leaderboardTopUserId: top?.userId ?? null,
      leaderboardTopAmountCent: top?.amountCent ?? null,
      consistencyOk,
    };

    const reportFile = `${reportDir}/2.0-${caseId}-${Date.now()}.json`;
    writeFileSync(reportFile, JSON.stringify(result, null, 2));
    appendFileSync('直播竞猜测试执行记录.md', [
      '',
      `## 2.0 专项测试执行记录 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
      '',
      `用例：\`${caseId}\``,
      '',
      `结果文件：\`${reportFile}\``,
      '',
      '| 指标 | 结果 |',
      '|---|---|',
      `| 总结果 | ${result.status} |`,
      `| 测试模型 | ${result.users} 用户在线，${result.activeBidders} 用户最后 1 分钟集中抢价 |`,
      `| WebSocket 连接 | ${result.connectedCount}/${result.users}，快照 ${result.snapshotCount}，成功率 ${result.connectionSuccessRate} |`,
      `| 出价 | 尝试 ${result.totalBidAttempts}，成功 ${result.acceptedBids}，业务拒绝 ${result.rejectedBids}，5xx ${result.systemErrors}，P95 ${result.bidP95Ms}ms |`,
      `| 自动延时 | 成功延时 ${result.acceptedExtensions}，成功率 ${result.extensionSuccessRate}，广播 ${result.extensionBroadcasts}/${result.expectedExtensionBroadcasts}，到达率 ${result.extensionBroadcastArrivalRate} |`,
      `| 广播延迟 | P95 ${result.broadcastP95Ms}ms，最大 ${result.broadcastMaxMs}ms |`,
      `| 结束后出价 | 尝试 ${result.afterEndBidAttempts}，成功 ${result.afterEndSuccess} |`,
      `| 价格回退 | ${result.priceRollbackCount} |`,
      `| 最终状态 | ${result.finalStatus}，当前价 ${result.finalCurrentPriceCent}，订单 ${result.orderId ?? '无'} |`,
      `| 最终一致性 | ${result.consistencyOk ? '通过' : '失败'} |`,
      '',
      result.status === 'PASS'
        ? '结论：`TC-MIX-002` 通过，最后 1 分钟集中抢价、自动延时、结束拒绝和最终一致性达到 2.0 验收标准。'
        : '结论：`TC-MIX-002` 未通过，需要根据上表定位自动延时、广播到达、结束拒绝或最终一致性问题。',
      '',
    ].join('\n'));

    console.log(JSON.stringify(result, null, 2));
  } finally {
    for (const socket of clients) socket.close();
    if (apiProcess) apiProcess.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
