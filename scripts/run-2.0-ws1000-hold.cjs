const { spawn } = require('node:child_process');
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

const caseId = args.get('case') ?? 'TC-WS1000-001';
const wsCount = Number(args.get('ws') ?? 1000);
const minutes = Number(args.get('minutes') ?? 10);
const reconnectBatch = Number(args.get('reconnect-batch') ?? 50);

function authHeaders(user) {
  return { Authorization: `Bearer ${user.token}` };
}

async function request(path, { method = 'GET', body, headers } = {}) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { ok: response.ok, status: response.status, data: await response.json().catch(() => ({})) };
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
    body: { name: `2.0 1000 WS 拍品 ${stamp}`, description: `${caseId} 自动化测试拍品` },
  });
  const room = await must('/live-rooms', {
    method: 'POST',
    headers: authHeaders(admin),
    body: { title: `2.0 1000 WS 直播间 ${stamp}` },
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
      durationSec: Math.max(900, minutes * 60 + 300),
    },
  });
  await must(`/auctions/${auction.id}/start`, { method: 'POST', headers: authHeaders(admin) });
  return auction;
}

async function connectOne(auctionId, metrics) {
  const socket = io(base, { transports: ['websocket'], reconnection: false, timeout: 10000 });
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
      () => connectOne(auctionId, metrics),
    ));
    results.push(...batch);
    await sleep(20);
  }
  return { results, durationMs: performance.now() - started };
}

function connectedCount(clients) {
  return clients.filter((item) => item.socket?.connected).length;
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

  const metrics = { disconnectEvents: 0 };
  let clients = [];

  try {
    await waitForHealth();
    const admin = await login(`2.0 ${caseId} 主播`, 'ADMIN');
    const auction = await setupAuction(admin);
    const initial = await connectMany(auction.id, wsCount, metrics);
    clients = initial.results;
    const initialConnected = initial.results.filter((item) => item.connected).length;
    const initialSnapshots = initial.results.filter((item) => item.snapshot).length;

    const samples = [];
    let reconnectAttempts = 0;
    let reconnectSuccess = 0;
    const endAt = Date.now() + minutes * 60 * 1000;
    let cursor = 0;
    while (Date.now() < endAt) {
      await sleep(Math.min(60_000, Math.max(0, endAt - Date.now())));
      samples.push({ at: new Date().toISOString(), connected: connectedCount(clients) });
      if (Date.now() >= endAt) break;

      const indexes = [];
      for (let i = 0; i < reconnectBatch && clients.length > 0; i += 1) {
        indexes.push(cursor % clients.length);
        cursor += 1;
      }
      for (const index of indexes) clients[index].socket?.close();
      reconnectAttempts += indexes.length;
      await sleep(5000);
      const replacements = await Promise.all(indexes.map(() => connectOne(auction.id, metrics)));
      replacements.forEach((item, offset) => {
        clients[indexes[offset]] = item;
      });
      reconnectSuccess += replacements.filter((item) => item.connected && item.snapshot).length;
      samples.push({ at: new Date().toISOString(), connected: connectedCount(clients), afterReconnect: true });
    }

    const finalConnected = connectedCount(clients);
    const initialConnectionRate = wsCount === 0 ? 0 : initialConnected / wsCount;
    const holdRate = initialConnected === 0 ? 0 : finalConnected / initialConnected;
    const reconnectRate = reconnectAttempts === 0 ? 1 : reconnectSuccess / reconnectAttempts;
    const healthAfterHold = await healthOk();

    const result = {
      caseId,
      status: (
        initialConnectionRate >= 0.95 &&
        holdRate >= 0.9 &&
        reconnectRate >= 0.9 &&
        healthAfterHold
      ) ? 'PASS' : 'FAIL',
      generatedAt: new Date().toISOString(),
      auctionId: auction.id,
      apiWasRunning,
      wsCount,
      minutes,
      reconnectBatch,
      initialConnected,
      initialSnapshots,
      initialConnectionRate: Number(initialConnectionRate.toFixed(4)),
      connectionDurationMs: Number(initial.durationMs.toFixed(2)),
      finalConnected,
      holdRate: Number(holdRate.toFixed(4)),
      reconnectAttempts,
      reconnectSuccess,
      reconnectRate: Number(reconnectRate.toFixed(4)),
      disconnectEvents: metrics.disconnectEvents,
      healthAfterHold,
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
      `| 初始连接 | ${result.initialConnected}/${result.wsCount}，快照 ${result.initialSnapshots}，成功率 ${result.initialConnectionRate} |`,
      `| 建连耗时 | ${result.connectionDurationMs}ms |`,
      `| 10 分钟保持 | 最终在线 ${result.finalConnected}/${result.initialConnected}，保持率 ${result.holdRate} |`,
      `| 重连 | ${result.reconnectSuccess}/${result.reconnectAttempts}，成功率 ${result.reconnectRate} |`,
      `| API 健康 | ${result.healthAfterHold ? '通过' : '失败'} |`,
      `| 采样 | ${JSON.stringify(result.samples)} |`,
      '',
      result.status === 'PASS'
        ? '结论：`TC-WS1000-001` 通过，1000 WebSocket 在线 10 分钟保持、周期性重连和服务健康达到 2.0 验收标准。'
        : '结论：`TC-WS1000-001` 未通过，需要根据连接保持率、重连成功率或 API 健康状态定位问题。',
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
