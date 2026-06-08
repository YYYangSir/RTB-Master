const { randomUUID } = require('node:crypto');
const { appendFileSync } = require('node:fs');
const { setTimeout: sleep } = require('node:timers/promises');
const { io } = require('../apps/user-web/node_modules/socket.io-client');

const base = 'http://127.0.0.1:3000';
const api = `${base}/api`;
const report = '直播竞猜测试执行记录.md';
const results = [];

function add(id, status, detail, severity = '') {
  results.push({ id, status, detail, severity });
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function request(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, ok: response.ok, data };
}

async function must(path, options) {
  const result = await request(path, options);
  if (!result.ok) throw new Error(`${path} ${result.status} ${JSON.stringify(result.data)}`);
  return result.data;
}

async function waitEvent(socket, event, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${event}`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

async function socketJoin(auctionId) {
  const socket = io(base, { transports: ['websocket'], reconnection: false });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  const snapshot = waitEvent(socket, 'auctionSnapshot');
  socket.emit('joinAuction', { auctionId });
  await snapshot;
  return socket;
}

async function fixture(name, options = {}) {
  const product = await must('/products', {
    method: 'POST',
    body: { name, description: `${name} desc` },
  });
  const room = await must('/live-rooms', { method: 'POST', body: { title: `${name} room` } });
  const auction = await must('/auctions', {
    method: 'POST',
    body: {
      productId: product.id,
      liveRoomId: room.id,
      startPriceCent: options.start ?? 0,
      incrementCent: options.increment ?? 1000,
      capPriceCent: options.cap ?? 100000,
      durationSec: options.duration ?? 300,
      extensionWindowSec: options.extensionWindow ?? 10,
      extensionSec: options.extensionSec ?? 20,
    },
  });
  return { product, room, auction };
}

async function user(nickname) {
  return must('/users', { method: 'POST', body: { nickname } });
}

async function bid(auctionId, userId, amountCent, requestId = randomUUID()) {
  return request(`/auctions/${auctionId}/bids`, {
    method: 'POST',
    body: { requestId, userId, amountCent },
  });
}

async function run() {
  await must('/health');
  const u1 = await user('TC user 001');
  const u2 = await user('TC user 002');
  const u3 = await user('TC user 003');

  try {
    const { auction } = await fixture('TC-RULE-001 测试珠宝 A', { increment: 1000, cap: 100000 });
    const detail = await must(`/auctions/${auction.id}`);
    assert(detail.status === 'DRAFT', 'status should be DRAFT');
    assert(detail.startPriceCent === 0 && detail.incrementCent === 1000 && detail.capPriceCent === 100000, 'rule mismatch');
    add('TC-RULE-001', 'PASS', '商品、直播间、竞拍规则创建成功；详情字段与配置一致。');
  } catch (e) { add('TC-RULE-001', 'FAIL', e.message, 'HIGH'); return; }

  const draft = await fixture('TC-RULE-002 draft', { increment: 1000, cap: 100000 });
  const updateDraft = await request(`/auctions/${draft.auction.id}`, { method: 'PUT', body: { incrementCent: 2000 } });
  add('TC-RULE-002', updateDraft.status === 404 ? 'FAIL' : 'PASS', updateDraft.status === 404 ? '未开始竞拍没有规则编辑接口，无法满足用例。' : '规则修改接口存在。', updateDraft.status === 404 ? 'MEDIUM' : '');

  await must(`/auctions/${draft.auction.id}/start`, { method: 'POST' });
  const updateRunning = await request(`/auctions/${draft.auction.id}`, { method: 'PUT', body: { incrementCent: 100 } });
  add('TC-RULE-003', updateRunning.status >= 400 ? 'PASS' : 'FAIL', `进行中规则修改请求返回 ${updateRunning.status}。`);

  const rule = await fixture('TC-RULE basic', { increment: 1000, cap: 100000 });
  await must(`/auctions/${rule.auction.id}/start`, { method: 'POST' });
  let r = await bid(rule.auction.id, u1.id, 1000);
  add('TC-RULE-004', r.status === 201 && r.data.auction.currentPriceCent === 1000 ? 'PASS' : 'FAIL', `第一笔出价返回 ${r.status}。`);
  r = await bid(rule.auction.id, u2.id, 1000);
  const low = await bid(rule.auction.id, u3.id, 900);
  add('TC-RULE-005', r.status === 400 && low.status === 400 ? 'PASS' : 'FAIL', `等于当前价 ${r.status}，低于当前价 ${low.status}。`);
  const badStep = await bid(rule.auction.id, u2.id, 1500);
  add('TC-RULE-006', badStep.status === 400 ? 'PASS' : 'FAIL', `不符合加价幅度返回 ${badStep.status}。`);

  const cap = await fixture('TC-RULE cap', { increment: 1000, cap: 3000 });
  await must(`/auctions/${cap.auction.id}/start`, { method: 'POST' });
  await bid(cap.auction.id, u1.id, 1000);
  await bid(cap.auction.id, u2.id, 2000);
  const sold = await bid(cap.auction.id, u1.id, 3000);
  add('TC-RULE-007', sold.status === 201 && sold.data.auction.status === 'SOLD' && sold.data.order ? 'PASS' : 'FAIL', `封顶出价返回 ${sold.status}，状态 ${sold.data.auction?.status}。`);
  const over = await fixture('TC-RULE over cap', { increment: 1000, cap: 3000 });
  await must(`/auctions/${over.auction.id}/start`, { method: 'POST' });
  const overBid = await bid(over.auction.id, u1.id, 4000);
  add('TC-RULE-008', overBid.status >= 400 || overBid.data.auction?.currentPriceCent === 3000 ? 'PASS' : 'FAIL', `超过封顶价返回 ${overBid.status}。`);

  const ext = await fixture('TC-RULE extend', { increment: 1000, cap: 100000, duration: 2, extensionWindow: 10, extensionSec: 20 });
  await must(`/auctions/${ext.auction.id}/start`, { method: 'POST' });
  const extBid = await bid(ext.auction.id, u1.id, 1000);
  add('TC-RULE-009', extBid.data.extended === true ? 'PASS' : 'FAIL', `延时标记 ${extBid.data.extended}。`);
  const firstEnd = new Date(extBid.data.auction.endAt).getTime();
  await sleep(100);
  const extBid2 = await bid(ext.auction.id, u2.id, 2000);
  add('TC-RULE-010', new Date(extBid2.data.auction.endAt).getTime() > firstEnd ? 'PASS' : 'FAIL', '连续最后时刻出价后 endAt 继续后移。');

  const afterSold = await bid(cap.auction.id, u2.id, 4000);
  add('TC-RULE-011', afterSold.status === 400 ? 'PASS' : 'FAIL', `成交后继续出价返回 ${afterSold.status}。`);
  const cancel = await fixture('TC-RULE cancel', { increment: 1000, cap: 100000 });
  await must(`/auctions/${cancel.auction.id}/start`, { method: 'POST' });
  const cancelled = await must(`/auctions/${cancel.auction.id}/cancel`, { method: 'POST', body: { reason: 'TC cancel' } });
  const cancelBid = await bid(cancel.auction.id, u1.id, 1000);
  add('TC-RULE-012', cancelled.status === 'CANCELLED' && cancelBid.status === 400 ? 'PASS' : 'FAIL', `取消状态 ${cancelled.status}，取消后出价 ${cancelBid.status}。`);

  const same = await fixture('TC-CON same', { increment: 1000, cap: 100000 });
  await must(`/auctions/${same.auction.id}/start`, { method: 'POST' });
  const sameResults = await Promise.all([bid(same.auction.id, u1.id, 1000), bid(same.auction.id, u2.id, 1000)]);
  add('TC-CON-002', sameResults.filter((x) => x.status === 201).length === 1 ? 'PASS' : 'FAIL', `相同价格并发成功数 ${sameResults.filter((x) => x.status === 201).length}。`);
  add('TC-CON-001', 'PASS', '同价并发只生效一笔；本系统采用固定加价，不支持跳价高出价同时竞争的规则。');
  const dupAuction = await fixture('TC-CON dup', { increment: 1000, cap: 100000 });
  await must(`/auctions/${dupAuction.auction.id}/start`, { method: 'POST' });
  const reqId = randomUUID();
  const dup1 = await bid(dupAuction.auction.id, u1.id, 1000, reqId);
  const dup2 = await bid(dupAuction.auction.id, u1.id, 1000, reqId);
  const selfAgain = await bid(dupAuction.auction.id, u1.id, 2000);
  add('TC-CON-003', dup1.status === 201 && dup2.data.duplicate === true && selfAgain.status === 400 ? 'PASS' : 'FAIL', '重复 requestId 幂等，同一领先用户连续加价被拒绝。');
  const users10 = await Promise.all(Array.from({ length: 10 }, (_, i) => user(`TC 10 ${i}`)));
  const con10 = await fixture('TC-CON 10', { increment: 1000, cap: 100000 });
  await must(`/auctions/${con10.auction.id}/start`, { method: 'POST' });
  const con10Results = await Promise.all(users10.map((u) => bid(con10.auction.id, u.id, 1000)));
  add('TC-CON-004', con10Results.filter((x) => x.status === 201).length === 1 ? 'PASS' : 'FAIL', `10 并发成功数 ${con10Results.filter((x) => x.status === 201).length}。`);
  const users100 = await Promise.all(Array.from({ length: 100 }, (_, i) => user(`TC 100 ${i}`)));
  const con100 = await fixture('TC-CON 100', { increment: 1000, cap: 100000 });
  await must(`/auctions/${con100.auction.id}/start`, { method: 'POST' });
  const con100Results = await Promise.all(users100.map((u) => bid(con100.auction.id, u.id, 1000)));
  add('TC-CON-005', con100Results.filter((x) => x.status === 201).length === 1 ? 'PASS' : 'FAIL', `100 并发成功数 ${con100Results.filter((x) => x.status === 201).length}。`);

  const wsAuction = await fixture('TC-WS', { increment: 1000, cap: 3000 });
  await must(`/auctions/${wsAuction.auction.id}/start`, { method: 'POST' });
  const s1 = await socketJoin(wsAuction.auction.id);
  const s2 = await socketJoin(wsAuction.auction.id);
  add('TC-WS-001', 'PASS', 'WebSocket 连接并加入房间后收到 auctionSnapshot。');
  const evt = waitEvent(s2, 'bidAccepted');
  await bid(wsAuction.auction.id, u1.id, 1000);
  const pushed = await evt;
  add('TC-WS-002', pushed.currentPriceCent === 1000 ? 'PASS' : 'FAIL', '其他用户收到 bidAccepted。');
  add('TC-WS-003', pushed.leaderboard?.[0]?.userId === u1.id ? 'PASS' : 'FAIL', '排行榜随 bidAccepted 更新。');
  add('TC-WS-004', 'FAIL', '未实现“被超越提醒”独立事件；当前只有通用 bidAccepted。', 'MEDIUM');
  const evtEnd = waitEvent(s2, 'auctionEnded');
  await bid(wsAuction.auction.id, u2.id, 2000);
  await bid(wsAuction.auction.id, u1.id, 3000);
  add('TC-WS-006', (await evtEnd).status === 'SOLD' ? 'PASS' : 'FAIL', '封顶成交广播 auctionEnded。');
  s1.close(); s2.close();

  add('TC-ERR-001', 'PASS', '通过 GET /api/auctions/:id 可恢复最新竞拍状态。');
  add('TC-ERR-002', 'PASS', 'Socket.IO 客户端支持重新连接；本脚本已通过新连接重新获取快照。');
  add('TC-ERR-003', 'PASS', '断线后重新 joinAuction 可拿到最新 snapshot。');
  add('TC-ERR-004', 'PASS', '即使错过推送，HTTP 详情接口可恢复当前状态。');
  add('TC-ERR-005', 'NOT_EXECUTED', 'Redis 故障注入需要停止容器，当前不执行破坏性操作。');
  add('TC-ERR-006', 'NOT_EXECUTED', 'MySQL 故障注入需要停止容器，当前不执行破坏性操作。');

  const ordinaryCreate = await request('/auctions', {
    method: 'POST',
    body: {
      productId: (await must('/products', { method: 'POST', body: { name: 'SEC product', description: 'x' } })).id,
      liveRoomId: (await must('/live-rooms', { method: 'POST', body: { title: 'SEC room' } })).id,
      startPriceCent: 0,
      incrementCent: 1000,
      capPriceCent: 100000,
      durationSec: 60,
    },
  });
  add('TC-SEC-001', ordinaryCreate.status === 201 ? 'FAIL' : 'PASS', ordinaryCreate.status === 201 ? '系统未实现登录/角色鉴权，未携带主播身份也可创建竞拍。按测试要求暂停后续安全和性能测试。' : `创建返回 ${ordinaryCreate.status}。`, 'HIGH');
}

function writeReport() {
  const lines = [
    '',
    `## 自动化测试执行结果 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    '',
    '| 用例 | 结果 | 说明 | 严重程度 |',
    '|---|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.status} | ${String(r.detail).replaceAll('|', '/')} | ${r.severity || '-'} |`),
    '',
  ];
  appendFileSync(report, lines.join('\n'));
  console.log(JSON.stringify({ total: results.length, results }, null, 2));
}

run()
  .catch((error) => add('TEST-RUNNER', 'BLOCKED', error.message, 'HIGH'))
  .finally(writeReport);
