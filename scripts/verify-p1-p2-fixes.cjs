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

function authHeaders(user) {
  return { Authorization: `Bearer ${user.token}` };
}

async function login(nickname, role) {
  const result = await must('/auth/login', { method: 'POST', body: { nickname, role } });
  return { ...result.user, token: result.token };
}

async function fixture(admin, name, options = {}) {
  const product = await must('/products', { method: 'POST', headers: authHeaders(admin), body: { name, description: 'verify' } });
  const room = await must('/live-rooms', { method: 'POST', headers: authHeaders(admin), body: { title: `${name} room` } });
  const auction = await must('/auctions', {
    method: 'POST',
    headers: authHeaders(admin),
    body: {
      productId: product.id,
      liveRoomId: room.id,
      startPriceCent: options.startPriceCent ?? 0,
      incrementCent: options.incrementCent ?? 1000,
      capPriceCent: options.capPriceCent ?? 100000,
      durationSec: options.durationSec ?? 60,
      extensionWindowSec: options.extensionWindowSec ?? 10,
      extensionSec: options.extensionSec ?? 20,
    },
  });
  return auction;
}

async function bid(auctionId, user, amountCent, requestId = randomUUID()) {
  return request(`/auctions/${auctionId}/bids`, {
    method: 'POST',
    headers: authHeaders(user),
    body: { requestId, userId: user.id, amountCent },
  });
}

function waitEvent(socket, event, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${event}`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

async function joinSocket(auctionId, user) {
  const socket = io(base, { transports: ['websocket'], reconnection: false });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  const snapshot = waitEvent(socket, 'auctionSnapshot');
  socket.emit('joinAuction', { auctionId, userId: user.id, token: user.token });
  await snapshot;
  return socket;
}

async function run() {
  await waitForHealth();
  const admin = await login('verify admin', 'ADMIN');
  const u1 = await login('verify user 1', 'BIDDER');
  const u2 = await login('verify user 2', 'BIDDER');

  const draft = await fixture(admin, 'VERIFY update draft');
  const updated = await must(`/auctions/${draft.id}`, {
    method: 'PATCH',
    headers: authHeaders(admin),
    body: { incrementCent: 2000, capPriceCent: 200000, durationSec: 120, extensionWindowSec: 30, extensionSec: 15 },
  });
  assert(updated.incrementCent === 2000 && updated.capPriceCent === 200000 && updated.durationSec === 120, 'draft update fields mismatch');
  await must(`/auctions/${draft.id}/start`, { method: 'POST', headers: authHeaders(admin) });
  const runningUpdate = await request(`/auctions/${draft.id}`, { method: 'PATCH', headers: authHeaders(admin), body: { incrementCent: 1000 } });
  assert(runningUpdate.status === 400, 'running auction update should be rejected');
  add('FIX-RULE-002', 'PASS', 'DRAFT 竞拍允许修改规则；RUNNING 竞拍拒绝修改。');

  const ext = await fixture(admin, 'VERIFY repeated extension', { durationSec: 2, extensionWindowSec: 30, extensionSec: 20 });
  await must(`/auctions/${ext.id}/start`, { method: 'POST', headers: authHeaders(admin) });
  const first = await bid(ext.id, u1, 1000);
  assert(first.ok && first.data.extended === true, 'first last-window bid should extend');
  const firstEnd = new Date(first.data.auction.endAt).getTime();
  const second = await bid(ext.id, u2, 2000);
  assert(second.ok && second.data.extended === true, 'second bid should still be inside configured window and extend');
  const secondEnd = new Date(second.data.auction.endAt).getTime();
  assert(secondEnd > firstEnd, 'second extension did not move endAt forward');
  add('FIX-RULE-010', 'PASS', '连续处于延时窗口内的合法出价会继续后移 endAt。');

  const a = await fixture(admin, 'VERIFY room A', { capPriceCent: 100000 });
  const b = await fixture(admin, 'VERIFY room B', { capPriceCent: 100000 });
  await must(`/auctions/${a.id}/start`, { method: 'POST', headers: authHeaders(admin) });
  await must(`/auctions/${b.id}/start`, { method: 'POST', headers: authHeaders(admin) });
  const leaderSocket = await joinSocket(a.id, u1);
  const roomBSocket = await joinSocket(b.id, u2);
  await bid(a.id, u1, 1000);
  const outbidEvent = waitEvent(leaderSocket, 'outbid');
  const roomBLeak = waitEvent(roomBSocket, 'bidAccepted', 500).then(() => true).catch(() => false);
  await bid(a.id, u2, 2000);
  const outbid = await outbidEvent;
  assert(outbid.previousLeaderUserId === u1.id && outbid.newLeaderUserId === u2.id, 'outbid payload mismatch');
  assert(await roomBLeak === false, 'room B received room A bidAccepted');
  leaderSocket.close();
  roomBSocket.close();
  add('FIX-WS-004-007', 'PASS', '旧领先者收到 outbid 定向事件；其他竞拍房间未收到跨房间消息。');

  const invalidAuction = await fixture(admin, 'VERIFY invalid amount');
  await must(`/auctions/${invalidAuction.id}/start`, { method: 'POST', headers: authHeaders(admin) });
  const negative = await bid(invalidAuction.id, u1, -1);
  const stringAmount = await request(`/auctions/${invalidAuction.id}/bids`, {
    method: 'POST',
    headers: authHeaders(u1),
    body: { requestId: randomUUID(), userId: u1.id, amountCent: '1000' },
  });
  const huge = await bid(invalidAuction.id, u1, 1000000001);
  assert(negative.status === 400 && stringAmount.status === 400 && huge.status === 400, 'invalid amount validation mismatch');
  add('FIX-SEC-005', 'PASS', '负数、字符串、超大金额均被 DTO 校验拒绝。');

  const limitedAuction = await fixture(admin, 'VERIFY rate limit', { capPriceCent: 1000000 });
  await must(`/auctions/${limitedAuction.id}/start`, { method: 'POST', headers: authHeaders(admin) });
  const flood = await Promise.all(Array.from({ length: 70 }, () => bid(limitedAuction.id, u1, 1000)));
  const limited = flood.filter((item) => item.status === 429).length;
  assert(limited > 0, 'rate limit did not trigger');
  add('FIX-SEC-007', 'PASS', `同用户同竞拍高频请求触发 429，限流数量 ${limited}。`);
}

function writeReport() {
  const lines = [
    '',
    `## P1/P2 修复验证结果 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    '',
    '| 项目 | 结果 | 说明 |',
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
  .catch((error) => add('FIX-RUNNER', 'FAIL', error.message))
  .finally(writeReport);
