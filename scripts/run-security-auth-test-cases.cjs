const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { appendFileSync } = require('node:fs');
const { setTimeout: sleep } = require('node:timers/promises');
const { io } = require('../apps/user-web/node_modules/socket.io-client');

const base = 'http://127.0.0.1:3000';
const api = `${base}/api`;
const report = '直播竞猜测试执行记录.md';
const results = [];

function add(id, status, detail) {
  results.push({ id, status, detail });
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

function authHeaders(user) {
  return { Authorization: `Bearer ${user.token}` };
}

async function request(path, { method = 'GET', body, headers } = {}) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, ok: response.ok, data: await response.json().catch(() => ({})) };
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

async function createProductAndRoom(admin) {
  const product = await must('/products', {
    method: 'POST',
    headers: authHeaders(admin),
    body: { name: `SEC product ${Date.now()}`, description: 'security' },
  });
  const room = await must('/live-rooms', {
    method: 'POST',
    headers: authHeaders(admin),
    body: { title: `SEC room ${Date.now()}` },
  });
  return { product, room };
}

async function createAuction(admin, overrides = {}) {
  const { product, room } = await createProductAndRoom(admin);
  return must('/auctions', {
    method: 'POST',
    headers: authHeaders(admin),
    body: {
      productId: product.id,
      liveRoomId: room.id,
      startPriceCent: 0,
      incrementCent: 1000,
      capPriceCent: 3000,
      durationSec: 60,
      ...overrides,
    },
  });
}

async function bid(auctionId, user, amountCent, userId = user.id) {
  return request(`/auctions/${auctionId}/bids`, {
    method: 'POST',
    headers: authHeaders(user),
    body: { requestId: randomUUID(), userId, amountCent },
  });
}

async function joinAs(auctionId, user, userId = user.id, token = user.token) {
  const socket = io(base, { transports: ['websocket'], reconnection: false });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  const ack = await socket.timeout(1000).emitWithAck('joinAuction', { auctionId, userId, token }).catch((error) => ({
    ok: false,
    message: error.message,
  }));
  socket.close();
  return ack;
}

async function run() {
  await waitForHealth();
  const admin = await login('SEC admin', 'ADMIN');
  const bidderA = await login('SEC bidder A', 'BIDDER');
  const bidderB = await login('SEC bidder B', 'BIDDER');

  const { product, room } = await createProductAndRoom(admin);
  const bidderCreateProduct = await request('/products', {
    method: 'POST',
    headers: authHeaders(bidderA),
    body: { name: 'bad product', description: 'bad' },
  });
  const bidderCreateAuction = await request('/auctions', {
    method: 'POST',
    headers: authHeaders(bidderA),
    body: {
      productId: product.id,
      liveRoomId: room.id,
      startPriceCent: 0,
      incrementCent: 1000,
      capPriceCent: 3000,
      durationSec: 60,
    },
  });
  add('TC-SEC-001', bidderCreateProduct.status === 403 && bidderCreateAuction.status === 403 ? 'PASS' : 'FAIL', `普通用户创建商品=${bidderCreateProduct.status}，创建竞拍=${bidderCreateAuction.status}`);

  const auction = await createAuction(admin);
  await must(`/auctions/${auction.id}/start`, { method: 'POST', headers: authHeaders(admin) });
  const bidderCancel = await request(`/auctions/${auction.id}/cancel`, {
    method: 'POST',
    headers: authHeaders(bidderA),
    body: { reason: 'bad cancel' },
  });
  add('TC-SEC-002', bidderCancel.status === 403 ? 'PASS' : 'FAIL', `普通用户取消竞拍返回 ${bidderCancel.status}`);

  const otherBid = await bid(auction.id, bidderA, 1000, bidderB.id);
  add('TC-SEC-003', otherBid.status === 400 ? 'PASS' : 'FAIL', `用户 A 代替用户 B 出价返回 ${otherBid.status}`);

  const anonymousBid = await request(`/auctions/${auction.id}/bids`, {
    method: 'POST',
    body: { requestId: randomUUID(), userId: bidderA.id, amountCent: 1000 },
  });
  add('TC-SEC-004', anonymousBid.status === 401 ? 'PASS' : 'FAIL', `未登录出价返回 ${anonymousBid.status}`);

  const negative = await bid(auction.id, bidderA, -1);
  const stringAmount = await request(`/auctions/${auction.id}/bids`, {
    method: 'POST',
    headers: authHeaders(bidderA),
    body: { requestId: randomUUID(), userId: bidderA.id, amountCent: '1000' },
  });
  const huge = await bid(auction.id, bidderA, 1000000001);
  add('TC-SEC-005', negative.status === 400 && stringAmount.status === 400 && huge.status === 400 ? 'PASS' : 'FAIL', `负数=${negative.status} 字符串=${stringAmount.status} 超大=${huge.status}`);

  await bid(auction.id, bidderA, 1000);
  await bid(auction.id, bidderB, 2000);
  await bid(auction.id, bidderA, 3000);
  const afterSold = await bid(auction.id, bidderB, 4000);
  add('TC-SEC-006', afterSold.status === 400 ? 'PASS' : 'FAIL', `结束后接口出价返回 ${afterSold.status}`);

  const limitedAuction = await createAuction(admin, { capPriceCent: 1000000 });
  await must(`/auctions/${limitedAuction.id}/start`, { method: 'POST', headers: authHeaders(admin) });
  const flood = await Promise.all(Array.from({ length: 70 }, () => bid(limitedAuction.id, bidderA, 1000)));
  const limited = flood.filter((item) => item.status === 429).length;
  add('TC-SEC-007', limited > 0 ? 'PASS' : 'FAIL', `高频恶意出价 429 数量=${limited}`);

  const wsAuction = await createAuction(admin);
  const noTokenAck = await joinAs(wsAuction.id, bidderA, bidderA.id, '');
  const mismatchAck = await joinAs(wsAuction.id, bidderA, bidderB.id, bidderA.token);
  const okAck = await joinAs(wsAuction.id, bidderA);
  add('TC-SEC-008', noTokenAck.ok === false && mismatchAck.ok === false && okAck.ok === true ? 'PASS' : 'FAIL', `无token=${JSON.stringify(noTokenAck)} token不匹配=${JSON.stringify(mismatchAck)} 正常=${JSON.stringify(okAck)}`);
}

function writeReport() {
  const lines = [
    '',
    `## 安全鉴权测试执行结果 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    '',
    '| 用例 | 结果 | 说明 |',
    '|---|---|---|',
    ...results.map((result) => `| ${result.id} | ${result.status} | ${result.detail.replaceAll('|', '/')} |`),
    '',
  ];
  appendFileSync(report, lines.join('\n'));
  console.log(JSON.stringify(results, null, 2));
}

async function main() {
  const apiProcess = spawn('pnpm', ['--filter', 'api-server', 'exec', 'node', 'dist/main.js'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    await run();
  } finally {
    apiProcess.kill('SIGTERM');
  }
}

main()
  .catch((error) => add('SEC-RUNNER', 'FAIL', error.message))
  .finally(writeReport);
