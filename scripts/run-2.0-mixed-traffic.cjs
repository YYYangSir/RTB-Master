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

const caseId = args.get('case') ?? 'TC-MIX-001';
const users = Number(args.get('users') ?? 100);
const minutes = Number(args.get('minutes') ?? 10);
const durationMs = minutes * 60 * 1000;
const viewerCount = Math.max(0, users - 20);
const lowBidderCount = Math.min(15, Math.max(0, users - viewerCount));
const highBidderCount = Math.min(5, Math.max(0, users - viewerCount - lowBidderCount));

function authHeaders(user) {
  return { Authorization: `Bearer ${user.token}` };
}

function randomBetween(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
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
  if (!result.ok) {
    throw new Error(`${path} ${result.status} ${JSON.stringify(result.data)}`);
  }
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
    body: { name: `2.0 混合流量拍品 ${stamp}`, description: `${caseId} 自动化测试拍品` },
  });
  const room = await must('/live-rooms', {
    method: 'POST',
    headers: authHeaders(admin),
    body: { title: `2.0 混合流量直播间 ${stamp}` },
  });
  const auction = await must('/auctions', {
    method: 'POST',
    headers: authHeaders(admin),
    body: {
      productId: product.id,
      liveRoomId: room.id,
      startPriceCent: 0,
      incrementCent: 100,
      capPriceCent: 100000000,
      durationSec: Math.ceil(durationMs / 1000),
      extensionWindowSec: 60,
      extensionSec: 30,
    },
  });
  await must(`/auctions/${auction.id}/start`, { method: 'POST', headers: authHeaders(admin) });
  return auction;
}

async function connectClient(auctionId, user, index, metrics) {
  const socket = io(base, { transports: ['websocket'], reconnection: false, timeout: 10_000 });
  socket.on('bidAccepted', (payload) => {
    metrics.broadcastReceived += 1;
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
  socket.on('auctionExtended', () => {
    metrics.extensionEvents += 1;
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
      if (payload?.endAt) metrics.latestEndAt = payload.endAt;
      resolve(true);
    });
    socket.emit('joinAuction', { auctionId, userId: user.id, token: user.token });
  });
  return { socket, connected: true, snapshot };
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

async function bidOnce(auctionId, user, metrics) {
  let amountCent = metrics.latestPriceCent + 100;
  const result = await request(`/auctions/${auctionId}/bids`, {
    method: 'POST',
    headers: authHeaders(user),
    body: { requestId: randomUUID(), userId: user.id, amountCent },
  });
  metrics.bidLatencies.push(result.latencyMs);
  metrics.totalBidAttempts += 1;
  if (result.status >= 500) metrics.systemErrors += 1;
  if (result.ok) {
    metrics.acceptedBids += 1;
    metrics.latestPriceCent = Math.max(metrics.latestPriceCent, result.data.currentPriceCent ?? amountCent);
    metrics.latestLeaderUserId = user.id;
    return;
  }
  metrics.rejectedBids += 1;
  const message = String(result.data?.message ?? result.data?.error ?? result.status);
  metrics.businessErrors[message] = (metrics.businessErrors[message] ?? 0) + 1;
  if (result.status === 400) {
    const detail = await request(`/auctions/${auctionId}`);
    if (detail.ok) {
      metrics.latestPriceCent = Math.max(metrics.latestPriceCent, detail.data.currentPriceCent ?? 0);
      metrics.latestLeaderUserId = detail.data.leaderUserId ?? metrics.latestLeaderUserId;
    }
  }
}

async function runBidderLoop(auctionId, user, metrics, endAt, lowFrequency) {
  while (Date.now() < endAt) {
    const remaining = endAt - Date.now();
    const finalMinute = remaining <= 60_000;
    const waitMs = finalMinute
      ? randomBetween(lowFrequency ? 5000 : 1000, lowFrequency ? 10000 : 3000)
      : randomBetween(lowFrequency ? 20_000 : 3000, lowFrequency ? 40_000 : 8000);
    await sleep(Math.min(waitMs, Math.max(0, endAt - Date.now())));
    if (Date.now() >= endAt) break;
    await bidOnce(auctionId, user, metrics);
  }
}

async function reconnectSample(auctionId, clients, metrics) {
  const sample = clients.slice(0, 10);
  for (const client of sample) client.socket.close();
  await sleep(10_000);
  const reconnected = await Promise.all(sample.map((client) => connectClient(
    auctionId,
    client.user,
    client.index,
    metrics,
  )));
  for (let i = 0; i < sample.length; i += 1) {
    sample[i].socket = reconnected[i].socket;
  }
  metrics.reconnectAttempts = sample.length;
  metrics.reconnectSuccess = reconnected.filter((item) => item.connected && item.snapshot).length;
}

async function waitForFinished(auctionId, maxWaitMs) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const detail = await must(`/auctions/${auctionId}`);
    if (detail.status !== 'RUNNING') return detail;
    await sleep(1000);
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
    totalBidAttempts: 0,
    acceptedBids: 0,
    rejectedBids: 0,
    systemErrors: 0,
    businessErrors: {},
    bidLatencies: [],
    broadcastReceived: 0,
    broadcastLatencies: [],
    priceRollbackCount: 0,
    lastSeenPriceBySocket: {},
    disconnects: 0,
    reconnectAttempts: 0,
    reconnectSuccess: 0,
    extensionEvents: 0,
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
    const connectionStarted = performance.now();
    const connected = await Promise.all(allUsers.map((user, index) => connectClient(
      auction.id,
      user,
      index,
      metrics,
    )));
    clients = connected.map((item, index) => ({ ...item, user: allUsers[index], index }));
    const connectedCount = connected.filter((item) => item.connected).length;
    const snapshotCount = connected.filter((item) => item.snapshot).length;
    const connectionDurationMs = performance.now() - connectionStarted;

    const lowBidders = allUsers.slice(viewerCount, viewerCount + lowBidderCount);
    const highBidders = allUsers.slice(viewerCount + lowBidderCount, viewerCount + lowBidderCount + highBidderCount);
    const endAt = Date.now() + durationMs;
    const loops = [
      ...lowBidders.map((user) => runBidderLoop(auction.id, user, metrics, endAt, true)),
      ...highBidders.map((user) => runBidderLoop(auction.id, user, metrics, endAt, false)),
      sleep(Math.min(durationMs / 2, 5 * 60_000)).then(() => reconnectSample(auction.id, clients, metrics)),
    ];
    await Promise.all(loops);

    const detail = await waitForFinished(auction.id, 120_000);
    await sleep(1000);
    const leaderboard = await must(`/auctions/${auction.id}/leaderboard`);
    const top = leaderboard.leaderboard?.[0] ?? null;
    const order = detail.order ?? null;
    const systemErrorRate = metrics.totalBidAttempts === 0 ? 0 : metrics.systemErrors / metrics.totalBidAttempts;
    const reconnectRate = metrics.reconnectAttempts === 0 ? 1 : metrics.reconnectSuccess / metrics.reconnectAttempts;
    const connectionSuccessRate = users === 0 ? 0 : connectedCount / users;
    const consistencyOk = Boolean(
      detail.status === 'SOLD' &&
      order &&
      top &&
      detail.currentPriceCent === top.amountCent &&
      detail.currentPriceCent === order.amountCent &&
      detail.leaderUserId === top.userId &&
      detail.leaderUserId === order.winnerUserId,
    );

    const result = {
      caseId,
      status: (
        connectionSuccessRate >= 0.99 &&
        reconnectRate >= 0.95 &&
        systemErrorRate <= 0.01 &&
        metrics.priceRollbackCount === 0 &&
        percentile(metrics.broadcastLatencies, 0.95) <= 1000 &&
        consistencyOk
      ) ? 'PASS' : 'FAIL',
      startedAt: new Date(Date.now() - durationMs).toISOString(),
      endedAt: new Date().toISOString(),
      users,
      viewerCount,
      lowBidderCount,
      highBidderCount,
      minutes,
      auctionId: auction.id,
      apiWasRunning,
      connectedCount,
      snapshotCount,
      connectionDurationMs: Number(connectionDurationMs.toFixed(2)),
      connectionSuccessRate: Number(connectionSuccessRate.toFixed(4)),
      disconnects: metrics.disconnects,
      reconnectAttempts: metrics.reconnectAttempts,
      reconnectSuccess: metrics.reconnectSuccess,
      reconnectRate: Number(reconnectRate.toFixed(4)),
      totalBidAttempts: metrics.totalBidAttempts,
      acceptedBids: metrics.acceptedBids,
      rejectedBids: metrics.rejectedBids,
      systemErrors: metrics.systemErrors,
      systemErrorRate: Number(systemErrorRate.toFixed(4)),
      businessErrors: metrics.businessErrors,
      bidP95Ms: Number(percentile(metrics.bidLatencies, 0.95).toFixed(2)),
      bidMaxMs: Number(Math.max(0, ...metrics.bidLatencies).toFixed(2)),
      broadcastReceived: metrics.broadcastReceived,
      broadcastP95Ms: Number(percentile(metrics.broadcastLatencies, 0.95).toFixed(2)),
      broadcastMaxMs: Number(Math.max(0, ...metrics.broadcastLatencies).toFixed(2)),
      priceRollbackCount: metrics.priceRollbackCount,
      extensionEvents: metrics.extensionEvents,
      finalStatus: detail.status,
      finalCurrentPriceCent: detail.currentPriceCent,
      finalLeaderUserId: detail.leaderUserId,
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
      `| 流量模型 | 观看 ${result.viewerCount}，低频 ${result.lowBidderCount}，高频 ${result.highBidderCount} |`,
      `| WebSocket 连接 | ${result.connectedCount}/${result.users}，快照 ${result.snapshotCount}，成功率 ${result.connectionSuccessRate} |`,
      `| 重连恢复 | ${result.reconnectSuccess}/${result.reconnectAttempts}，恢复率 ${result.reconnectRate} |`,
      `| 出价 | 尝试 ${result.totalBidAttempts}，成功 ${result.acceptedBids}，业务拒绝 ${result.rejectedBids}，5xx ${result.systemErrors}，P95 ${result.bidP95Ms}ms |`,
      `| 业务拒绝原因 | ${JSON.stringify(result.businessErrors)} |`,
      `| 广播 | 收到 ${result.broadcastReceived}，P95 ${result.broadcastP95Ms}ms |`,
      `| 自动延时事件 | ${result.extensionEvents} |`,
      `| 价格回退 | ${result.priceRollbackCount} |`,
      `| 最终状态 | ${result.finalStatus}，当前价 ${result.finalCurrentPriceCent}，订单 ${result.orderId ?? '无'} |`,
      `| 最终一致性 | ${result.consistencyOk ? '通过' : '失败'} |`,
      '',
      result.status === 'PASS'
        ? '结论：`TC-MIX-001` 通过，100 用户真实混合竞拍流量在当前测试窗口下达到 2.0 验收标准。'
        : '结论：`TC-MIX-001` 未通过，需要根据上表定位连接、重连、出价、广播或最终一致性问题。',
      '',
    ].join('\n'));

    console.log(JSON.stringify(result, null, 2));
  } finally {
    for (const client of clients) client.socket?.close();
    if (apiProcess) apiProcess.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
