const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const { io } = require('../apps/user-web/node_modules/socket.io-client');

const base = 'http://127.0.0.1:3000';
const api = `${base}/api`;

async function request(path, { method = 'GET', body, headers } = {}) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

async function expectError(path, { method = 'GET', body, headers, status }) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  assert(response.status === status, `${method} ${path}: expected ${status}, got ${response.status}`);
  return data;
}

async function rawRequest(path, { method = 'GET', body, headers } = {}) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json() };
}

function authHeaders(user) {
  return { Authorization: `Bearer ${user.token}` };
}

async function login(nickname, role) {
  const result = await request('/auth/login', { method: 'POST', body: { nickname, role } });
  return { ...result.user, token: result.token };
}

async function createAuction(admin, productId, liveRoomId, overrides = {}) {
  const auction = await request('/auctions', {
    method: 'POST',
    headers: authHeaders(admin),
    body: {
      productId,
      liveRoomId,
      startPriceCent: 0,
      incrementCent: 10000,
      capPriceCent: 50000,
      durationSec: 120,
      ...overrides,
    },
  });
  await request(`/auctions/${auction.id}/start`, { method: 'POST', headers: authHeaders(admin) });
  return auction;
}

function bidBody(user, amountCent, requestId = randomUUID()) {
  return { requestId, userId: user.id, amountCent };
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await request('/health');
      return;
    } catch {
      await sleep(200);
    }
  }
  throw new Error('API did not become healthy');
}

function connectSocket() {
  return new Promise((resolve, reject) => {
    const socket = io(base, { transports: ['websocket'], reconnection: false });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function waitEvent(socket, event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), 3000);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

async function runFlow() {
  const admin = await login('Smoke 主播', 'ADMIN');
  const product = await request('/products', {
    method: 'POST',
    headers: authHeaders(admin),
    body: { name: 'Smoke 演示珠宝', description: '完整闭环验证商品' },
  });
  const room = await request('/live-rooms', {
    method: 'POST',
    headers: authHeaders(admin),
    body: { title: 'Smoke 直播间' },
  });
  const userA = await login('Smoke 用户 A', 'BIDDER');
  const userB = await login('Smoke 用户 B', 'BIDDER');
  const auction = await request('/auctions', {
    method: 'POST',
    headers: authHeaders(admin),
    body: {
      productId: product.id,
      liveRoomId: room.id,
      startPriceCent: 0,
      incrementCent: 10000,
      capPriceCent: 30000,
      durationSec: 120,
    },
  });
  await request(`/auctions/${auction.id}/start`, { method: 'POST', headers: authHeaders(admin) });

  const clientA = await connectSocket();
  const clientB = await connectSocket();
  const snapshotA = waitEvent(clientA, 'auctionSnapshot');
  clientA.emit('joinAuction', { auctionId: auction.id });
  await snapshotA;
  const snapshotB = waitEvent(clientB, 'auctionSnapshot');
  clientB.emit('joinAuction', { auctionId: auction.id });
  await snapshotB;

  const broadcastA1 = waitEvent(clientA, 'bidAccepted');
  const broadcastB1 = waitEvent(clientB, 'bidAccepted');
  await expectError(`/auctions/${auction.id}/bids`, {
    method: 'POST',
    headers: authHeaders(userA),
    body: bidBody(userA, 9999),
    status: 400,
  });
  const firstRequestId = randomUUID();
  await request(`/auctions/${auction.id}/bids`, {
    method: 'POST',
    headers: authHeaders(userA),
    body: bidBody(userA, 10000, firstRequestId),
  });
  const firstBroadcastA = await broadcastA1;
  assert(firstBroadcastA.currentPriceCent === 10000, 'client A missed first broadcast');
  assert((await broadcastB1).currentPriceCent === 10000, 'client B missed first broadcast');
  assert(firstBroadcastA.leaderboard[0].userId === userA.id, 'leaderboard missed user A');
  assert(firstBroadcastA.participantCount === 1, 'participant count should be 1');
  const duplicate = await request(`/auctions/${auction.id}/bids`, {
    method: 'POST',
    headers: authHeaders(userA),
    body: bidBody(userA, 10000, firstRequestId),
  });
  assert(duplicate.duplicate === true, 'duplicate request was not idempotent');
  await expectError(`/auctions/${auction.id}/bids`, {
    method: 'POST',
    headers: authHeaders(userA),
    body: bidBody(userA, 20000),
    status: 400,
  });

  const broadcastA2 = waitEvent(clientA, 'bidAccepted');
  await request(`/auctions/${auction.id}/bids`, {
    method: 'POST',
    headers: authHeaders(userB),
    body: bidBody(userB, 20000),
  });
  const secondBroadcast = await broadcastA2;
  assert(secondBroadcast.leaderUserId === userB.id, 'leader did not change to user B');
  assert(secondBroadcast.leaderboard[0].userId === userB.id, 'leaderboard did not rank user B first');
  assert(secondBroadcast.leaderboard[1].userId === userA.id, 'leaderboard did not rank user A second');
  assert(secondBroadcast.participantCount === 2, 'participant count should be 2');

  const recoveryClient = await connectSocket();
  const recoveredSnapshot = waitEvent(recoveryClient, 'auctionSnapshot');
  recoveryClient.emit('joinAuction', { auctionId: auction.id });
  const recovered = await recoveredSnapshot;
  assert(recovered.currentPriceCent === 20000, 'recovered snapshot price mismatch');
  assert(recovered.leaderUserId === userB.id, 'recovered snapshot leader mismatch');
  assert(recovered.leaderboard[0].userId === userB.id, 'recovered snapshot leaderboard mismatch');
  recoveryClient.close();

  const ended = waitEvent(clientA, 'auctionEnded');
  const sold = await request(`/auctions/${auction.id}/bids`, {
    method: 'POST',
    headers: authHeaders(userA),
    body: bidBody(userA, 30000),
  });
  assert(sold.auction.status === 'SOLD', 'auction did not sell at cap price');
  assert((await ended).status === 'SOLD', 'auctionEnded was not broadcast');
  assert(sold.order.winnerUserId === userA.id, 'winner mismatch');
  await expectError(`/auctions/${auction.id}/bids`, {
    method: 'POST',
    headers: authHeaders(userB),
    body: bidBody(userB, 40000),
    status: 400,
  });

  const order = await request(`/orders/${sold.order.id}`);
  assert(order.status === 'PENDING_PAYMENT', 'new order should be pending');
  const paid = await request(`/orders/${order.id}/pay`, { method: 'POST' });
  assert(paid.status === 'PAID', 'payment did not complete');
  const soldDetail = await request(`/auctions/${auction.id}`);
  assert(soldDetail.bids.length === 3, 'auction detail should contain three accepted bids');
  assert(soldDetail.bids[0].amountCent === 30000, 'auction detail bids should be newest first');
  assert(soldDetail.bids[0].user.nickname === 'Smoke 用户 A', 'auction detail bidder nickname mismatch');
  assert(soldDetail.order.winner.nickname === 'Smoke 用户 A', 'auction detail order winner mismatch');

  const extensionAuction = await request('/auctions', {
    method: 'POST',
    headers: authHeaders(admin),
    body: {
      productId: product.id,
      liveRoomId: room.id,
      startPriceCent: 0,
      incrementCent: 10000,
      capPriceCent: 50000,
      durationSec: 2,
      extensionWindowSec: 10,
      extensionSec: 20,
    },
  });
  await request(`/auctions/${extensionAuction.id}/start`, { method: 'POST', headers: authHeaders(admin) });
  const extensionClient = await connectSocket();
  const extensionSnapshot = waitEvent(extensionClient, 'auctionSnapshot');
  extensionClient.emit('joinAuction', { auctionId: extensionAuction.id });
  await extensionSnapshot;
  const extendedEvent = waitEvent(extensionClient, 'auctionExtended');
  const extendedBid = await request(`/auctions/${extensionAuction.id}/bids`, {
    method: 'POST',
    headers: authHeaders(userA),
    body: bidBody(userA, 10000),
  });
  const extended = await extendedEvent;
  assert(extendedBid.extended === true, 'last-second bid did not extend auction');
  assert(extended.endAt === extendedBid.auction.endAt, 'extended endAt broadcast mismatch');
  extensionClient.close();

  const cancelledAuction = await request('/auctions', {
    method: 'POST',
    headers: authHeaders(admin),
    body: {
      productId: product.id,
      liveRoomId: room.id,
      startPriceCent: 0,
      incrementCent: 10000,
      capPriceCent: 50000,
      durationSec: 120,
    },
  });
  await request(`/auctions/${cancelledAuction.id}/start`, { method: 'POST', headers: authHeaders(admin) });
  const cancelClient = await connectSocket();
  const cancelSnapshot = waitEvent(cancelClient, 'auctionSnapshot');
  cancelClient.emit('joinAuction', { auctionId: cancelledAuction.id });
  await cancelSnapshot;
  const cancelledEvent = waitEvent(cancelClient, 'auctionCancelled');
  const cancelled = await request(`/auctions/${cancelledAuction.id}/cancel`, {
    method: 'POST',
    headers: authHeaders(admin),
    body: { reason: 'Smoke 主播异常取消' },
  });
  assert(cancelled.status === 'CANCELLED', 'auction did not cancel');
  assert((await cancelledEvent).cancelReason === 'Smoke 主播异常取消', 'cancel reason broadcast mismatch');
  await expectError(`/auctions/${cancelledAuction.id}/bids`, {
    method: 'POST',
    headers: authHeaders(userB),
    body: bidBody(userB, 10000),
    status: 400,
  });
  const cancelledDetail = await request(`/auctions/${cancelledAuction.id}`);
  assert(cancelledDetail.order === null, 'cancelled auction should not create order');
  cancelClient.close();

  const concurrentAuction = await request('/auctions', {
    method: 'POST',
    headers: authHeaders(admin),
    body: {
      productId: product.id,
      liveRoomId: room.id,
      startPriceCent: 0,
      incrementCent: 10000,
      capPriceCent: 50000,
      durationSec: 120,
    },
  });
  await request(`/auctions/${concurrentAuction.id}/start`, { method: 'POST', headers: authHeaders(admin) });
  const concurrentResults = await Promise.all([
    rawRequest(`/auctions/${concurrentAuction.id}/bids`, {
      method: 'POST',
      headers: authHeaders(userA),
      body: bidBody(userA, 10000),
    }),
    rawRequest(`/auctions/${concurrentAuction.id}/bids`, {
      method: 'POST',
      headers: authHeaders(userB),
      body: bidBody(userB, 10000),
    }),
  ]);
  assert(
    concurrentResults.filter((result) => result.status === 201).length === 1,
    'concurrent bids should accept exactly one request',
  );
  assert(
    concurrentResults.filter((result) => result.status === 400).length === 1,
    'concurrent bids should reject one stale price request',
  );

  const timedSoldAuction = await request('/auctions', {
    method: 'POST',
    headers: authHeaders(admin),
    body: {
      productId: product.id,
      liveRoomId: room.id,
      startPriceCent: 0,
      incrementCent: 10000,
      capPriceCent: 50000,
      durationSec: 2,
      extensionWindowSec: 1,
    },
  });
  await request(`/auctions/${timedSoldAuction.id}/start`, { method: 'POST', headers: authHeaders(admin) });
  await request(`/auctions/${timedSoldAuction.id}/bids`, {
    method: 'POST',
    headers: authHeaders(userA),
    body: bidBody(userA, 10000),
  });
  await sleep(2600);
  const timedSold = await request(`/auctions/${timedSoldAuction.id}`);
  assert(timedSold.status === 'SOLD', 'timed auction with leader should sell');
  assert(timedSold.order?.winnerUserId === userA.id, 'timed sold winner mismatch');

  const timedUnsoldAuction = await request('/auctions', {
    method: 'POST',
    headers: authHeaders(admin),
    body: {
      productId: product.id,
      liveRoomId: room.id,
      startPriceCent: 0,
      incrementCent: 10000,
      capPriceCent: 50000,
      durationSec: 1,
    },
  });
  await request(`/auctions/${timedUnsoldAuction.id}/start`, { method: 'POST', headers: authHeaders(admin) });
  await sleep(1600);
  const timedUnsold = await request(`/auctions/${timedUnsoldAuction.id}`);
  assert(timedUnsold.status === 'UNSOLD', 'timed auction without bids should be unsold');
  assert(timedUnsold.order === null, 'unsold auction should not create order');
  const auctionRecords = await request('/auctions');
  assert(auctionRecords.items.length <= 10, 'auction history page should contain at most 10 records');
  assert(auctionRecords.pageSize === 10, 'auction history default page size should be 10');
  assert(
    auctionRecords.items.every((item, index, items) => (
      index === 0 || new Date(items[index - 1].createdAt) >= new Date(item.createdAt)
    )),
    'auction history should be sorted newest first',
  );
  assert(auctionRecords.items.some((item) => item.id === auction.id), 'sold auction missing from history');
  assert(auctionRecords.items.some((item) => item.id === concurrentAuction.id), 'parallel auction missing from history');
  assert(
    auctionRecords.items.find((item) => item.id === auction.id).status === 'SOLD',
    'sold auction history status mismatch',
  );

  clientA.close();
  clientB.close();
  return {
    auctionId: auction.id,
    orderId: order.id,
    finalStatus: sold.auction.status,
    winner: paid.winner.nickname,
    paidStatus: paid.status,
    extensionStatus: extendedBid.extended ? 'EXTENDED' : 'NOT_EXTENDED',
    cancelledStatus: cancelled.status,
    cancelledOrder: cancelledDetail.order,
    leaderboardStatus: 'CONSISTENT',
    recoveryStatus: 'RECOVERED',
    illegalLowBidStatus: 'REJECTED',
    duplicateRequestStatus: 'IDEMPOTENT',
    afterSoldBidStatus: 'REJECTED',
    concurrentBidStatus: 'ONE_ACCEPTED_ONE_STALE_PRICE_REJECTED',
    selfLeadingBidStatus: 'REJECTED',
    timedSoldStatus: timedSold.status,
    timedUnsoldStatus: timedUnsold.status,
    auctionHistoryStatus: 'PRESERVED',
    auctionPaginationStatus: 'TEN_PER_PAGE_NEWEST_FIRST',
    auctionDetailStatus: 'WITH_BID_HISTORY_AND_ORDER',
  };
}

async function main() {
  const apiProcess = spawn('pnpm', ['--filter', 'api-server', 'exec', 'node', 'dist/main.js'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    await waitForHealth();
    console.log(JSON.stringify(await runFlow(), null, 2));
  } finally {
    apiProcess.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
