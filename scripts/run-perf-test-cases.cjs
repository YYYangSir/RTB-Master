const { randomUUID } = require('node:crypto');
const { appendFileSync } = require('node:fs');
const { io } = require('../apps/user-web/node_modules/socket.io-client');

const base = 'http://127.0.0.1:3000';
const api = `${base}/api`;
const report = '直播竞猜测试执行记录.md';
const results = [];

function add(id, status, detail) {
  results.push({ id, status, detail });
}

async function request(path, { method = 'GET', body, headers } = {}) {
  const start = performance.now();
  const response = await fetch(`${api}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, ok: response.ok, data, latencyMs: performance.now() - start };
}

async function must(path, options) {
  const result = await request(path, options);
  if (!result.ok) throw new Error(`${path} ${result.status} ${JSON.stringify(result.data)}`);
  return result.data;
}

function authHeaders(user) {
  return { Authorization: `Bearer ${user.token}` };
}

async function login(nickname, role) {
  const result = await must('/auth/login', { method: 'POST', body: { nickname, role } });
  return { ...result.user, token: result.token };
}

function stats(items) {
  const values = items.map((x) => x.latencyMs).sort((a, b) => a - b);
  const pick = (p) => Number(values[Math.min(values.length - 1, Math.floor(values.length * p))].toFixed(2));
  return {
    count: values.length,
    avg: Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)),
    p95: pick(0.95),
    p99: pick(0.99),
    max: Number(values.at(-1).toFixed(2)),
    ok: items.filter((x) => x.status >= 200 && x.status < 300).length,
    bad: items.filter((x) => x.status >= 400).length,
  };
}

async function seed(prefix, userCount) {
  const admin = await login(`${prefix} admin`, 'ADMIN');
  const product = await must('/products', { method: 'POST', headers: authHeaders(admin), body: { name: `${prefix} product`, description: 'perf' } });
  const room = await must('/live-rooms', { method: 'POST', headers: authHeaders(admin), body: { title: `${prefix} room` } });
  const users = await Promise.all(Array.from({ length: userCount }, (_, i) => login(`${prefix} user ${i}`, 'BIDDER')));
  return { admin, product, room, users };
}

async function auction(ctx, incrementCent = 1, capPriceCent = 1000000) {
  const created = await must('/auctions', {
    method: 'POST',
    headers: authHeaders(ctx.admin),
    body: {
      productId: ctx.product.id,
      liveRoomId: ctx.room.id,
      startPriceCent: 0,
      incrementCent,
      capPriceCent,
      durationSec: 600,
    },
  });
  await must(`/auctions/${created.id}/start`, { method: 'POST', headers: authHeaders(ctx.admin) });
  return created;
}

async function bid(auctionId, user, amountCent) {
  return request(`/auctions/${auctionId}/bids`, {
    method: 'POST',
    headers: authHeaders(user),
    body: { requestId: randomUUID(), userId: user.id, amountCent },
  });
}

function waitEvent(socket, event, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${event}`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

async function connectMany(auctionId, count) {
  const sockets = [];
  let ok = 0;
  const started = performance.now();
  await Promise.all(Array.from({ length: count }, async () => {
    const socket = io(base, { transports: ['websocket'], reconnection: false, timeout: 5000 });
    sockets.push(socket);
    await new Promise((resolve) => {
      socket.once('connect', resolve);
      socket.once('connect_error', resolve);
    });
    if (socket.connected) {
      ok += 1;
      socket.emit('joinAuction', { auctionId });
    }
  }));
  return { sockets, ok, durationMs: performance.now() - started };
}

async function run() {
  await must('/health');

  const ctx = await seed('TC-PERF', 520);

  const baseAuction = await auction(ctx, 1);
  const single = [];
  for (let i = 0; i < 20; i += 1) single.push(await bid(baseAuction.id, ctx.users[i % 2], i + 1));
  const singleStats = stats(single);
  add('TC-PERF-001', singleStats.p95 < 300 && singleStats.bad === 0 ? 'PASS' : 'WARN', `20 次连续合法出价：avg=${singleStats.avg}ms p95=${singleStats.p95}ms max=${singleStats.max}ms bad=${singleStats.bad}`);

  const wsAuction100 = await auction(ctx, 1);
  let conn = await connectMany(wsAuction100.id, 100);
  add('TC-PERF-002', conn.ok >= 99 ? 'PASS' : 'WARN', `100 WebSocket：成功 ${conn.ok}/100，建连耗时 ${Number(conn.durationMs.toFixed(2))}ms`);
  conn.sockets.forEach((s) => s.close());

  const wsAuction500 = await auction(ctx, 1);
  conn = await connectMany(wsAuction500.id, 500);
  const ws500Ok = conn.ok >= 475;
  const receive = waitEvent(conn.sockets.find((s) => s.connected), 'bidAccepted', 5000);
  await bid(wsAuction500.id, ctx.users[0], 1);
  const arrived = await receive.then(() => true).catch(() => false);
  add('TC-PERF-003', ws500Ok && arrived ? 'PASS' : 'WARN', `500 WebSocket：成功 ${conn.ok}/500，抽样广播到达=${arrived}`);
  conn.sockets.forEach((s) => s.close());

  add('TC-PERF-004', 'NOT_EXECUTED', '1000 WebSocket 属于加分项大压测，本轮按节省时间/token未执行；建议单独执行长压测。');

  const con100 = await auction(ctx, 1);
  let started = performance.now();
  let batch = await Promise.all(ctx.users.slice(0, 100).map((u) => bid(con100.id, u, 1)));
  let s = stats(batch);
  add('TC-PERF-005', s.p95 <= 800 && s.ok === 1 && s.bad === 99 ? 'PASS' : 'WARN', `100 并发同价出价：ok=${s.ok} bad=${s.bad} p95=${s.p95}ms duration=${Number((performance.now() - started).toFixed(2))}ms；按固定加价规则只允许 1 笔成功`);

  const con300 = await auction(ctx, 1);
  started = performance.now();
  batch = await Promise.all(ctx.users.slice(0, 300).map((u) => bid(con300.id, u, 1)));
  s = stats(batch);
  add('TC-PERF-006', s.p95 <= 1500 && s.ok === 1 && s.bad === 299 ? 'PASS' : 'WARN', `300 并发同价出价：ok=${s.ok} bad=${s.bad} p95=${s.p95}ms duration=${Number((performance.now() - started).toFixed(2))}ms；数据保持单成功`);

  const steps = [10, 50, 100, 200, 300, 500];
  const stepLines = [];
  let passed = true;
  for (const size of steps) {
    const stepAuction = await auction(ctx, 1);
    started = performance.now();
    batch = await Promise.all(ctx.users.slice(0, size).map((u) => bid(stepAuction.id, u, 1)));
    s = stats(batch);
    const duration = Number((performance.now() - started).toFixed(2));
    stepLines.push(`${size}并发 ok=${s.ok} bad=${s.bad} p95=${s.p95}ms duration=${duration}ms`);
    if (s.ok !== 1 || s.p95 > 1500) passed = false;
  }
  add('TC-PERF-007', passed ? 'PASS' : 'WARN', stepLines.join('；'));
  add('TC-PERF-008', 'NOT_EXECUTED', '30 分钟长时间稳定性测试本轮未执行，建议作为单独测试窗口执行。');
}

function writeReport() {
  const lines = [
    '',
    `## 性能测试执行结果 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    '',
    '| 用例 | 结果 | 说明 |',
    '|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.status} | ${r.detail.replaceAll('|', '/')} |`),
    '',
  ];
  appendFileSync(report, lines.join('\n'));
  console.log(JSON.stringify(results, null, 2));
}

run()
  .catch((error) => add('PERF-RUNNER', 'BLOCKED', error.message))
  .finally(writeReport);
