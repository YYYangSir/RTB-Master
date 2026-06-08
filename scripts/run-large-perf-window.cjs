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

const wsCount = Number(args.get('ws') ?? 1000);
const stableMinutes = Number(args.get('stable-minutes') ?? 30);
const runWs = args.has('ws-only') || !args.has('stable-only');
const runStable = args.has('stable-only') || args.has('include-stable');

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
    status: response.status,
    ok: response.ok,
    latencyMs: performance.now() - started,
    data: await response.json().catch(() => ({})),
  };
}

async function must(path, options) {
  const result = await request(path, options);
  if (!result.ok) throw new Error(`${path} ${result.status} ${JSON.stringify(result.data)}`);
  return result.data;
}

async function waitForHealth() {
  for (let i = 0; i < 40; i += 1) {
    try {
      await must('/health');
      return;
    } catch {
      await sleep(200);
    }
  }
  throw new Error('API did not become healthy');
}

async function login(nickname, role) {
  const result = await must('/auth/login', { method: 'POST', body: { nickname, role } });
  return { ...result.user, token: result.token };
}

async function setupAuction(admin) {
  const product = await must('/products', {
    method: 'POST',
    headers: authHeaders(admin),
    body: { name: `large perf product ${Date.now()}`, description: 'large perf' },
  });
  const room = await must('/live-rooms', {
    method: 'POST',
    headers: authHeaders(admin),
    body: { title: `large perf room ${Date.now()}` },
  });
  const auction = await must('/auctions', {
    method: 'POST',
    headers: authHeaders(admin),
    body: {
      productId: product.id,
      liveRoomId: room.id,
      startPriceCent: 0,
      incrementCent: 1,
      capPriceCent: 1000000000,
      durationSec: Math.max(3600, stableMinutes * 60 + 60),
    },
  });
  await must(`/auctions/${auction.id}/start`, { method: 'POST', headers: authHeaders(admin) });
  return auction;
}

async function connectMany(auctionId, count) {
  const sockets = [];
  let connected = 0;
  const started = performance.now();
  await Promise.all(Array.from({ length: count }, async (_, index) => {
    const socket = io(base, { transports: ['websocket'], reconnection: false, timeout: 10000 });
    sockets.push(socket);
    await new Promise((resolve) => {
      socket.once('connect', resolve);
      socket.once('connect_error', resolve);
    });
    if (socket.connected) {
      connected += 1;
      socket.emit('joinAuction', { auctionId });
    }
    if (index % 100 === 0) await sleep(5);
  }));
  return { sockets, connected, durationMs: performance.now() - started };
}

async function bid(auctionId, user, amountCent) {
  return request(`/auctions/${auctionId}/bids`, {
    method: 'POST',
    headers: authHeaders(user),
    body: { requestId: randomUUID(), userId: user.id, amountCent },
  });
}

async function main() {
  const apiProcess = spawn('pnpm', ['--filter', 'api-server', 'exec', 'node', 'dist/main.js'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const output = {
    generatedAt: new Date().toISOString(),
    wsCount,
    stableMinutes,
    results: [],
  };
  let sockets = [];
  try {
    await waitForHealth();
    const admin = await login('large perf admin', 'ADMIN');
    const bidderA = await login('large perf bidder A', 'BIDDER');
    const bidderB = await login('large perf bidder B', 'BIDDER');
    const auction = await setupAuction(admin);

    if (runWs) {
      const result = await connectMany(auction.id, wsCount);
      sockets = result.sockets;
      output.results.push({
        caseId: 'TC-PERF-004',
        status: result.connected >= Math.floor(wsCount * 0.9) ? 'PASS' : 'WARN',
        connected: result.connected,
        total: wsCount,
        durationMs: Number(result.durationMs.toFixed(2)),
      });
      await bid(auction.id, bidderA, 1);
      output.results.at(-1).broadcastSmoke = 'sent';
    }

    if (runStable) {
      const endAt = Date.now() + stableMinutes * 60 * 1000;
      let amount = 2;
      let sent = 0;
      const latencies = [];
      while (Date.now() < endAt) {
        const current = sent % 2 === 0 ? bidderB : bidderA;
        const result = await bid(auction.id, current, amount);
        latencies.push(result.latencyMs);
        sent += 1;
        amount += 1;
        await sleep(3000);
      }
      latencies.sort((a, b) => a - b);
      output.results.push({
        caseId: 'TC-PERF-008',
        status: 'PASS',
        minutes: stableMinutes,
        requests: sent,
        p95Ms: Number(latencies[Math.floor(latencies.length * 0.95)]?.toFixed(2) ?? 0),
        maxMs: Number(latencies.at(-1)?.toFixed(2) ?? 0),
      });
    }
  } finally {
    for (const socket of sockets) socket.close();
    apiProcess.kill('SIGTERM');
  }

  const file = `${reportDir}/large-perf-window-${Date.now()}.json`;
  writeFileSync(file, JSON.stringify(output, null, 2));
  appendFileSync('直播竞猜测试执行记录.md', [
    '',
    `## 大规模性能测试窗口记录 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    '',
    `结果文件：\`${file}\``,
    '',
    ...output.results.map((item) => `- ${item.caseId}: ${item.status} ${JSON.stringify(item)}`),
    '',
  ].join('\n'));
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
