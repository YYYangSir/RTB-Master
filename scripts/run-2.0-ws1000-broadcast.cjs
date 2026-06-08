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

const caseId = args.get('case') ?? 'TC-WS1000-002';
const wsCount = Number(args.get('ws') ?? 1000);
const minutes = Number(args.get('minutes') ?? 10);
const intervalSec = Number(args.get('interval') ?? 5);

function authHeaders(user) {
  return { Authorization: `Bearer ${user.token}` };
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function average(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
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
    body: { name: `2.0 1000 WS 广播拍品 ${stamp}`, description: `${caseId} 自动化测试拍品` },
  });
  const room = await must('/live-rooms', {
    method: 'POST',
    headers: authHeaders(admin),
    body: { title: `2.0 1000 WS 广播直播间 ${stamp}` },
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
      durationSec: Math.max(900, minutes * 60 + 300),
    },
  });
  await must(`/auctions/${auction.id}/start`, { method: 'POST', headers: authHeaders(admin) });
  return auction;
}

async function connectOne(auctionId, metrics, index) {
  const socket = io(base, { transports: ['websocket'], reconnection: false, timeout: 10000 });
  socket.on('bidAccepted', (payload) => {
    metrics.received += 1;
    if (typeof payload?.serverTime === 'number') {
      metrics.latencies.push(Math.max(0, Date.now() - payload.serverTime));
    }
    const price = payload?.currentPriceCent ?? 0;
    const lastPrice = metrics.lastPriceByClient[index] ?? 0;
    if (price < lastPrice) metrics.outOfOrderCount += 1;
    metrics.lastPriceByClient[index] = price;
  });
  socket.on('disconnect', () => {
    metrics.disconnectEvents += 1;
  });
  await new Promise((resolve) => {
    socket.once('connect', resolve);
    socket.once('connect_error', resolve);
  });
  if (!socket.connected) return { socket, connected: false, snapshot: false };
  const snapshot = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 3000);
    socket.once('auctionSnapshot', () => {
      clearTimeout(timer);
      resolve(true);
    });
    socket.emit('joinAuction', { auctionId });
  });
  return { socket, connected: true, snapshot };
}

async function connectMany(auctionId, count, metrics) {
  const started = performance.now();
  const results = [];
  for (let offset = 0; offset < count; offset += 100) {
    const batch = await Promise.all(Array.from(
      { length: Math.min(100, count - offset) },
      (_, index) => connectOne(auctionId, metrics, offset + index),
    ));
    results.push(...batch);
    await sleep(20);
  }
  return { results, durationMs: performance.now() - started };
}

async function bid(auctionId, user, amountCent) {
  return request(`/auctions/${auctionId}/bids`, {
    method: 'POST',
    headers: authHeaders(user),
    body: { requestId: randomUUID(), userId: user.id, amountCent },
  });
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
    received: 0,
    latencies: [],
    lastPriceByClient: {},
    outOfOrderCount: 0,
    disconnectEvents: 0,
  };
  let clients = [];

  try {
    await waitForHealth();
    const admin = await login(`2.0 ${caseId} 主播`, 'ADMIN');
    const bidderA = await login(`2.0 ${caseId} 出价 A`, 'BIDDER');
    const bidderB = await login(`2.0 ${caseId} 出价 B`, 'BIDDER');
    const auction = await setupAuction(admin);

    const initial = await connectMany(auction.id, wsCount, metrics);
    clients = initial.results;
    const connected = clients.filter((item) => item.connected).length;
    const snapshots = clients.filter((item) => item.snapshot).length;

    const endAt = Date.now() + minutes * 60 * 1000;
    let amountCent = 100;
    let acceptedBroadcasts = 0;
    let bidFailures = 0;
    const bidLatencies = [];
    const samples = [];

    while (Date.now() < endAt) {
      const bidder = acceptedBroadcasts % 2 === 0 ? bidderA : bidderB;
      const result = await bid(auction.id, bidder, amountCent);
      bidLatencies.push(result.latencyMs);
      if (result.ok) {
        acceptedBroadcasts += 1;
        amountCent += 100;
      } else {
        bidFailures += 1;
        const detail = await request(`/auctions/${auction.id}`);
        if (detail.ok) amountCent = (detail.data.currentPriceCent ?? amountCent) + 100;
      }
      samples.push({
        at: new Date().toISOString(),
        acceptedBroadcasts,
        received: metrics.received,
      });
      await sleep(Math.min(intervalSec * 1000, Math.max(0, endAt - Date.now())));
    }

    await sleep(1000);
    const expectedMessages = connected * acceptedBroadcasts;
    const arrivalRate = expectedMessages === 0 ? 0 : metrics.received / expectedMessages;
    const connectionRate = wsCount === 0 ? 0 : connected / wsCount;
    const healthAfter = await healthOk();
    const result = {
      caseId,
      status: (
        connectionRate >= 0.95 &&
        arrivalRate >= 0.9 &&
        average(metrics.latencies) <= 1000 &&
        percentile(metrics.latencies, 0.95) <= 2000 &&
        percentile(metrics.latencies, 0.99) <= 3000 &&
        metrics.outOfOrderCount === 0 &&
        healthAfter
      ) ? 'PASS' : 'FAIL',
      generatedAt: new Date().toISOString(),
      auctionId: auction.id,
      apiWasRunning,
      wsCount,
      minutes,
      intervalSec,
      connected,
      snapshots,
      connectionRate: Number(connectionRate.toFixed(4)),
      connectionDurationMs: Number(initial.durationMs.toFixed(2)),
      acceptedBroadcasts,
      bidFailures,
      bidP95Ms: Number(percentile(bidLatencies, 0.95).toFixed(2)),
      expectedMessages,
      receivedMessages: metrics.received,
      arrivalRate: Number(arrivalRate.toFixed(4)),
      avgLatencyMs: Number(average(metrics.latencies).toFixed(2)),
      p95LatencyMs: Number(percentile(metrics.latencies, 0.95).toFixed(2)),
      p99LatencyMs: Number(percentile(metrics.latencies, 0.99).toFixed(2)),
      maxLatencyMs: Number(Math.max(0, ...metrics.latencies).toFixed(2)),
      outOfOrderCount: metrics.outOfOrderCount,
      disconnectEvents: metrics.disconnectEvents,
      healthAfter,
      samples,
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
      `| WebSocket 连接 | ${result.connected}/${result.wsCount}，快照 ${result.snapshots}，成功率 ${result.connectionRate} |`,
      `| 广播触发 | ${result.acceptedBroadcasts} 次真实出价广播，出价失败 ${result.bidFailures} |`,
      `| 消息到达 | ${result.receivedMessages}/${result.expectedMessages}，到达率 ${result.arrivalRate} |`,
      `| 广播延迟 | 平均 ${result.avgLatencyMs}ms，P95 ${result.p95LatencyMs}ms，P99 ${result.p99LatencyMs}ms，最大 ${result.maxLatencyMs}ms |`,
      `| 乱序 | ${result.outOfOrderCount} |`,
      `| API 健康 | ${result.healthAfter ? '通过' : '失败'} |`,
      '',
      result.status === 'PASS'
        ? '结论：`TC-WS1000-002` 通过，1000 WebSocket 在线下持续真实出价广播的到达率和延迟达到 2.0 验收标准。'
        : '结论：`TC-WS1000-002` 未通过，需要根据到达率、延迟、乱序或 API 健康状态定位问题。',
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
