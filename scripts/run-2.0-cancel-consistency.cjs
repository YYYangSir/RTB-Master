const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { setTimeout: sleep } = require('node:timers/promises');
const { io } = require('../apps/user-web/node_modules/socket.io-client');
const Redis = require('../apps/api-server/node_modules/ioredis');
const { PrismaClient } = require('../apps/api-server/node_modules/@prisma/client');

const base = 'http://127.0.0.1:3000';
const api = `${base}/api`;
const reportDir = 'reports';
mkdirSync(reportDir, { recursive: true });

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));

const caseId = args.get('case') ?? 'TC-CONSIST-003';
const cancelReason = 'TC-CONSIST-003 取消竞拍一致性测试';

function authHeaders(user) {
  return { Authorization: `Bearer ${user.token}` };
}

async function request(path, { method = 'GET', body, headers, timeoutMs = 10_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(`${api}${path}`, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    return {
      ok: response.ok,
      status: response.status,
      latencyMs: performance.now() - started,
      data: await response.json().catch(() => ({})),
    };
  } catch (error) {
    return {
      ok: false,
      status: 'CLIENT_ERROR',
      latencyMs: performance.now() - started,
      data: { message: error.message },
    };
  } finally {
    clearTimeout(timer);
  }
}

async function must(path, options) {
  const result = await request(path, options);
  if (!result.ok) throw new Error(`${path} ${result.status} ${JSON.stringify(result.data)}`);
  return result.data;
}

async function healthOk() {
  return (await request('/health', { timeoutMs: 2000 })).ok;
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
    body: { name: `2.0 取消一致性拍品 ${stamp}`, description: `${caseId} 自动化测试拍品` },
  });
  const room = await must('/live-rooms', {
    method: 'POST',
    headers: authHeaders(admin),
    body: { title: `2.0 取消一致性直播间 ${stamp}` },
  });
  const auction = await must('/auctions', {
    method: 'POST',
    headers: authHeaders(admin),
    body: {
      productId: product.id,
      liveRoomId: room.id,
      startPriceCent: 0,
      incrementCent: 100,
      capPriceCent: 1000,
      durationSec: 600,
      extensionWindowSec: 30,
      extensionSec: 20,
    },
  });
  await must(`/auctions/${auction.id}/start`, { method: 'POST', headers: authHeaders(admin) });
  return auction;
}

async function connectObserver(auctionId, metrics) {
  const socket = io(base, { transports: ['websocket'], reconnection: false, timeout: 10_000 });
  socket.on('bidAccepted', (payload) => {
    metrics.bidAcceptedEvents += 1;
    metrics.lastBidAccepted = payload;
  });
  socket.on('auctionCancelled', (payload) => {
    metrics.auctionCancelledEvents += 1;
    metrics.auctionCancelled = payload;
  });
  await new Promise((resolve) => {
    socket.once('connect', resolve);
    socket.once('connect_error', resolve);
  });
  if (!socket.connected) throw new Error('observer socket did not connect');
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000);
    socket.once('auctionSnapshot', (payload) => {
      metrics.initialSnapshot = payload;
      clearTimeout(timer);
      resolve();
    });
    socket.emit('joinAuction', { auctionId });
  });
  return socket;
}

async function connectAndSnapshot(auctionId) {
  const socket = io(base, { transports: ['websocket'], reconnection: false, timeout: 10_000 });
  await new Promise((resolve) => {
    socket.once('connect', resolve);
    socket.once('connect_error', resolve);
  });
  if (!socket.connected) return { connected: false, snapshot: null, socket };
  const snapshot = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 3000);
    socket.once('auctionSnapshot', (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
    socket.emit('joinAuction', { auctionId });
  });
  return { connected: true, snapshot, socket };
}

async function bid(auctionId, user, amountCent) {
  return request(`/auctions/${auctionId}/bids`, {
    method: 'POST',
    headers: authHeaders(user),
    body: { requestId: randomUUID(), userId: user.id, amountCent },
  });
}

async function redisSnapshot(redis, auctionId) {
  const state = await redis.hgetall(`auction:${auctionId}:state`);
  const top = await redis.zrevrange(`auction:${auctionId}:leaderboard`, 0, 0, 'WITHSCORES');
  return {
    currentPriceCent: state.currentPriceCent ? Number(state.currentPriceCent) : null,
    leaderUserId: state.leaderUserId || null,
    status: state.status ?? null,
    version: state.version ? Number(state.version) : null,
    cancelReason: state.cancelReason || null,
    leaderboardTopUserId: top[0] ?? null,
    leaderboardTopAmountCent: top[1] ? Number(top[1]) : null,
  };
}

async function mysqlSnapshot(prisma, auctionId) {
  const auction = await prisma.auction.findUniqueOrThrow({ where: { id: auctionId }, include: { order: true } });
  const highestBid = await prisma.bid.findFirst({ where: { auctionId }, orderBy: { amountCent: 'desc' } });
  return {
    currentPriceCent: auction.currentPriceCent,
    leaderUserId: auction.leaderUserId,
    status: auction.status,
    version: auction.version,
    cancelReason: auction.cancelReason,
    bidCount: await prisma.bid.count({ where: { auctionId } }),
    highestBidAmountCent: highestBid?.amountCent ?? null,
    highestBidUserId: highestBid?.userId ?? null,
    orderCount: await prisma.order.count({ where: { auctionId } }),
    orderAmountCent: auction.order?.amountCent ?? null,
    orderWinnerUserId: auction.order?.winnerUserId ?? null,
  };
}

function allEqual(...values) {
  return values.every((value) => value === values[0]);
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

  const prisma = new PrismaClient();
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', { maxRetriesPerRequest: 1 });
  const metrics = { initialSnapshot: null, bidAcceptedEvents: 0, lastBidAccepted: null, auctionCancelledEvents: 0, auctionCancelled: null };
  let observer;
  let refreshedClient;

  try {
    await waitForHealth();
    const admin = await login(`2.0 ${caseId} 主播`, 'ADMIN');
    const userA = await login(`2.0 ${caseId} 用户 A`, 'BIDDER');
    const userB = await login(`2.0 ${caseId} 用户 B`, 'BIDDER');
    const userAfterCancel = await login(`2.0 ${caseId} 取消后出价用户`, 'BIDDER');
    const auction = await setupAuction(admin);
    observer = await connectObserver(auction.id, metrics);

    const bidA = await bid(auction.id, userA, 100);
    await sleep(100);
    const bidB = await bid(auction.id, userB, 200);
    await sleep(300);
    const beforeCancelMysql = await mysqlSnapshot(prisma, auction.id);

    const cancel = await request(`/auctions/${auction.id}/cancel`, {
      method: 'POST',
      headers: authHeaders(admin),
      body: { reason: cancelReason },
    });
    await sleep(800);
    refreshedClient = await connectAndSnapshot(auction.id);
    const afterCancelBid = await bid(auction.id, userAfterCancel, 300);

    const mysql = await mysqlSnapshot(prisma, auction.id);
    const redisState = await redisSnapshot(redis, auction.id);
    const httpDetail = await request(`/auctions/${auction.id}`);
    const httpLeaderboard = await request(`/auctions/${auction.id}/leaderboard`);
    const httpTop = httpLeaderboard.data?.leaderboard?.[0] ?? null;
    const wsTop = metrics.auctionCancelled?.leaderboard?.[0] ?? null;
    const refreshTop = refreshedClient.snapshot?.leaderboard?.[0] ?? null;

    const checks = {
      initialBidsOk: bidA.ok && bidB.ok,
      beforeCancelRunning: beforeCancelMysql.status === 'RUNNING' && beforeCancelMysql.currentPriceCent === 200,
      cancelOk: cancel.ok,
      afterCancelBidRejected: !afterCancelBid.ok && Number(afterCancelBid.status) < 500,
      statusAllCancelled: [
        mysql.status,
        redisState.status,
        httpDetail.data?.status,
        metrics.auctionCancelled?.status,
        refreshedClient.snapshot?.status,
      ].every((status) => status === 'CANCELLED'),
      noOrder: mysql.orderCount === 0 && !httpDetail.data?.order,
      historicalBidKept: mysql.bidCount === 2 && mysql.highestBidAmountCent === 200,
      priceAndLeaderKept: allEqual(
        mysql.currentPriceCent,
        mysql.highestBidAmountCent,
        redisState.currentPriceCent,
        redisState.leaderboardTopAmountCent,
        httpDetail.data?.currentPriceCent,
        httpTop?.amountCent,
        metrics.auctionCancelled?.currentPriceCent,
        wsTop?.amountCent,
        refreshedClient.snapshot?.currentPriceCent,
        refreshTop?.amountCent,
      ) && mysql.currentPriceCent === 200 && allEqual(
        mysql.leaderUserId,
        mysql.highestBidUserId,
        redisState.leaderUserId,
        redisState.leaderboardTopUserId,
        httpDetail.data?.leaderUserId,
        httpTop?.userId,
        metrics.auctionCancelled?.leaderUserId,
        wsTop?.userId,
        refreshedClient.snapshot?.leaderUserId,
        refreshTop?.userId,
      ) && mysql.leaderUserId === userB.id,
      cancelReasonConsistent: [
        mysql.cancelReason,
        redisState.cancelReason,
        httpDetail.data?.cancelReason,
        metrics.auctionCancelled?.cancelReason,
        refreshedClient.snapshot?.cancelReason,
      ].every((reason) => reason === cancelReason),
      websocketCancelReceived: metrics.auctionCancelledEvents === 1,
      refreshSnapshotOk: refreshedClient.connected && Boolean(refreshedClient.snapshot),
      httpOk: httpDetail.ok && httpLeaderboard.ok,
      healthAfter: await healthOk(),
    };

    const result = {
      caseId,
      status: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL',
      generatedAt: new Date().toISOString(),
      auctionId: auction.id,
      apiWasRunning,
      bidA: { ok: bidA.ok, status: bidA.status, latencyMs: Number(bidA.latencyMs.toFixed(2)) },
      bidB: { ok: bidB.ok, status: bidB.status, latencyMs: Number(bidB.latencyMs.toFixed(2)) },
      beforeCancelMysql,
      cancel: { ok: cancel.ok, status: cancel.status, latencyMs: Number(cancel.latencyMs.toFixed(2)) },
      afterCancelBid: {
        ok: afterCancelBid.ok,
        status: afterCancelBid.status,
        message: afterCancelBid.data?.message ?? afterCancelBid.data?.error ?? null,
      },
      mysql,
      redis: redisState,
      http: {
        detailStatus: httpDetail.status,
        currentPriceCent: httpDetail.data?.currentPriceCent ?? null,
        leaderUserId: httpDetail.data?.leaderUserId ?? null,
        status: httpDetail.data?.status ?? null,
        cancelReason: httpDetail.data?.cancelReason ?? null,
        orderAmountCent: httpDetail.data?.order?.amountCent ?? null,
        orderWinnerUserId: httpDetail.data?.order?.winnerUserId ?? null,
        leaderboardTopAmountCent: httpTop?.amountCent ?? null,
        leaderboardTopUserId: httpTop?.userId ?? null,
      },
      websocket: {
        bidAcceptedEvents: metrics.bidAcceptedEvents,
        auctionCancelledEvents: metrics.auctionCancelledEvents,
        currentPriceCent: metrics.auctionCancelled?.currentPriceCent ?? null,
        leaderUserId: metrics.auctionCancelled?.leaderUserId ?? null,
        status: metrics.auctionCancelled?.status ?? null,
        cancelReason: metrics.auctionCancelled?.cancelReason ?? null,
        leaderboardTopAmountCent: wsTop?.amountCent ?? null,
        leaderboardTopUserId: wsTop?.userId ?? null,
      },
      refreshSnapshot: {
        connected: refreshedClient.connected,
        currentPriceCent: refreshedClient.snapshot?.currentPriceCent ?? null,
        leaderUserId: refreshedClient.snapshot?.leaderUserId ?? null,
        status: refreshedClient.snapshot?.status ?? null,
        cancelReason: refreshedClient.snapshot?.cancelReason ?? null,
        leaderboardTopAmountCent: refreshTop?.amountCent ?? null,
        leaderboardTopUserId: refreshTop?.userId ?? null,
      },
      checks,
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
      `| 取消前状态 | ${JSON.stringify(result.beforeCancelMysql)} |`,
      `| 取消操作 | ${JSON.stringify(result.cancel)} |`,
      `| 取消后继续出价 | ${JSON.stringify(result.afterCancelBid)} |`,
      `| MySQL | ${JSON.stringify(result.mysql)} |`,
      `| Redis | ${JSON.stringify(result.redis)} |`,
      `| HTTP | ${JSON.stringify(result.http)} |`,
      `| WebSocket | ${JSON.stringify(result.websocket)} |`,
      `| 刷新快照 | ${JSON.stringify(result.refreshSnapshot)} |`,
      `| 检查项 | ${JSON.stringify(result.checks)} |`,
      '',
      result.status === 'PASS'
        ? '结论：`TC-CONSIST-003` 通过。取消竞拍后 MySQL、Redis、HTTP、WebSocket 和刷新快照均为 CANCELLED，历史出价保留，不生成订单，取消后继续出价被拒绝。'
        : '结论：`TC-CONSIST-003` 未通过。需要根据取消状态、订单、历史出价、刷新快照或取消后拒绝出价定位问题。',
      '',
    ].join('\n'));

    console.log(JSON.stringify(result, null, 2));
  } finally {
    observer?.close();
    refreshedClient?.socket?.close();
    await redis.quit().catch(() => {});
    await prisma.$disconnect().catch(() => {});
    if (apiProcess) apiProcess.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
