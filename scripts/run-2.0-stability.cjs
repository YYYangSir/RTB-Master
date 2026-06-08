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

const caseId = args.get('case') ?? 'TC-STAB-001';
const users = Number(args.get('users') ?? 100);
const minutes = Number(args.get('minutes') ?? 10);
const durationMs = minutes * 60 * 1000;
const bidIntervalMs = 10_000;

function authHeaders(user) {
  return { Authorization: `Bearer ${user.token}` };
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
    const result = await request('/health');
    return result.ok;
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
    body: { name: `2.0 长稳拍品 ${stamp}`, description: `${caseId} 自动化测试拍品` },
  });
  const room = await must('/live-rooms', {
    method: 'POST',
    headers: authHeaders(admin),
    body: { title: `2.0 长稳直播间 ${stamp}` },
  });
  const auction = await must('/auctions', {
    method: 'POST',
    headers: authHeaders(admin),
    body: {
      productId: product.id,
      liveRoomId: room.id,
      startPriceCent: 0,
      incrementCent: 100,
      capPriceCent: 1000000000,
      durationSec: Math.max(900, Math.ceil(durationMs / 1000) + 300),
      extensionWindowSec: 30,
      extensionSec: 30,
    },
  });
  await must(`/auctions/${auction.id}/start`, { method: 'POST', headers: authHeaders(admin) });
  return auction;
}

async function connectSocket(auctionId, index, metrics) {
  const socket = io(base, { transports: ['websocket'], reconnection: false, timeout: 10_000 });
  socket.on('bidAccepted', (payload) => {
    metrics.broadcastReceived += 1;
    if (typeof payload?.serverTime === 'number') {
      metrics.broadcastLatencies.push(Math.max(0, Date.now() - payload.serverTime));
    }
    const lastPrice = metrics.lastSeenPriceBySocket[index] ?? 0;
    if (payload?.currentPriceCent < lastPrice) metrics.priceRollbackCount += 1;
    metrics.lastSeenPriceBySocket[index] = payload?.currentPriceCent ?? lastPrice;
  });
  socket.on('disconnect', () => {
    metrics.disconnects += 1;
  });

  await new Promise((resolve) => {
    socket.once('connect', resolve);
    socket.once('connect_error', resolve);
  });

  if (!socket.connected) return { socket, connected: false };
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000);
    socket.once('auctionSnapshot', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.emit('joinAuction', { auctionId });
  });
  return { socket, connected: true };
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
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

  const startedAt = new Date();
  const metrics = {
    broadcastReceived: 0,
    broadcastLatencies: [],
    bidLatencies: [],
    disconnects: 0,
    priceRollbackCount: 0,
    lastSeenPriceBySocket: {},
  };
  let sockets = [];

  try {
    await waitForHealth();
    const admin = await login(`2.0 ${caseId} 主播`, 'ADMIN');
    const bidders = [];
    for (let i = 0; i < users; i += 1) {
      bidders.push(await login(`2.0 ${caseId} 用户 ${String(i + 1).padStart(3, '0')}`, 'BIDDER'));
    }

    const auction = await setupAuction(admin);
    const connectionStarted = performance.now();
    const connected = await Promise.all(
      Array.from({ length: users }, (_, index) => connectSocket(auction.id, index, metrics)),
    );
    sockets = connected.map((item) => item.socket);
    const connectedCount = connected.filter((item) => item.connected).length;
    const connectionDurationMs = performance.now() - connectionStarted;

    const endAt = Date.now() + durationMs;
    let bidCount = 0;
    let acceptedBids = 0;
    let rejectedBids = 0;
    let amountCent = 100;
    while (Date.now() < endAt) {
      const bidder = bidders[bidCount % bidders.length];
      const result = await request(`/auctions/${auction.id}/bids`, {
        method: 'POST',
        headers: authHeaders(bidder),
        body: { requestId: randomUUID(), userId: bidder.id, amountCent },
      });
      metrics.bidLatencies.push(result.latencyMs);
      bidCount += 1;
      if (result.ok) {
        acceptedBids += 1;
        amountCent += 100;
      } else {
        rejectedBids += 1;
      }
      await sleep(Math.min(bidIntervalMs, Math.max(0, endAt - Date.now())));
    }

    await sleep(1000);
    const [detail, leaderboard] = await Promise.all([
      must(`/auctions/${auction.id}`),
      must(`/auctions/${auction.id}/leaderboard`),
    ]);

    const expectedBroadcasts = connectedCount * acceptedBids;
    const connectionSuccessRate = users === 0 ? 0 : connectedCount / users;
    const connectionKeepRate = connectedCount === 0
      ? 0
      : (connectedCount - metrics.disconnects) / connectedCount;
    const broadcastArrivalRate = expectedBroadcasts === 0
      ? 1
      : metrics.broadcastReceived / expectedBroadcasts;
    const top = leaderboard.leaderboard?.[0] ?? null;
    const consistencyOk = (
      detail.currentPriceCent === amountCent - 100 &&
      detail.leaderUserId === bidders[(acceptedBids - 1) % bidders.length]?.id &&
      top?.amountCent === detail.currentPriceCent &&
      top?.userId === detail.leaderUserId
    );

    const result = {
      caseId,
      status: (
        connectionSuccessRate >= 0.99 &&
        connectionKeepRate >= 0.98 &&
        broadcastArrivalRate >= 0.98 &&
        percentile(metrics.bidLatencies, 0.95) <= 800 &&
        percentile(metrics.broadcastLatencies, 0.95) <= 1000 &&
        metrics.priceRollbackCount === 0 &&
        consistencyOk
      ) ? 'PASS' : 'FAIL',
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      users,
      minutes,
      auctionId: auction.id,
      apiWasRunning,
      connectedCount,
      connectionDurationMs: Number(connectionDurationMs.toFixed(2)),
      connectionSuccessRate: Number(connectionSuccessRate.toFixed(4)),
      disconnects: metrics.disconnects,
      connectionKeepRate: Number(connectionKeepRate.toFixed(4)),
      acceptedBids,
      rejectedBids,
      expectedBroadcasts,
      broadcastReceived: metrics.broadcastReceived,
      broadcastArrivalRate: Number(broadcastArrivalRate.toFixed(4)),
      bidP95Ms: Number(percentile(metrics.bidLatencies, 0.95).toFixed(2)),
      bidMaxMs: Number(Math.max(0, ...metrics.bidLatencies).toFixed(2)),
      broadcastP95Ms: Number(percentile(metrics.broadcastLatencies, 0.95).toFixed(2)),
      broadcastMaxMs: Number(Math.max(0, ...metrics.broadcastLatencies).toFixed(2)),
      priceRollbackCount: metrics.priceRollbackCount,
      finalCurrentPriceCent: detail.currentPriceCent,
      finalLeaderUserId: detail.leaderUserId,
      leaderboardTopUserId: top?.userId ?? null,
      leaderboardTopAmountCent: top?.amountCent ?? null,
      consistencyOk,
      duplicateOrderCount: detail.order ? 1 : 0,
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
      `| WebSocket 连接 | ${result.connectedCount}/${result.users}，成功率 ${result.connectionSuccessRate} |`,
      `| 连接保持 | 断开 ${result.disconnects}，保持率 ${result.connectionKeepRate} |`,
      `| 出价 | 成功 ${result.acceptedBids}，拒绝 ${result.rejectedBids}，P95 ${result.bidP95Ms}ms |`,
      `| 广播 | 收到 ${result.broadcastReceived}/${result.expectedBroadcasts}，到达率 ${result.broadcastArrivalRate}，P95 ${result.broadcastP95Ms}ms |`,
      `| 价格回退 | ${result.priceRollbackCount} |`,
      `| 最终一致性 | ${result.consistencyOk ? '通过' : '失败'} |`,
      '',
      result.status === 'PASS'
        ? `结论：\`${caseId}\` 通过，${users} WebSocket 在线 + ${minutes} 分钟持续竞拍稳定性达到当前 2.0 验收标准。`
        : `结论：\`${caseId}\` 未通过，需要根据上表定位连接、广播、延迟或最终一致性问题。`,
      '',
    ].join('\n'));

    console.log(JSON.stringify(result, null, 2));
  } finally {
    for (const socket of sockets) socket.close();
    if (apiProcess) apiProcess.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
