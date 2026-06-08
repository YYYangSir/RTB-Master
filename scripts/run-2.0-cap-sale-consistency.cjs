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

const caseId = args.get('case') ?? 'TC-CONSIST-002';

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
    body: { name: `2.0 封顶成交一致性拍品 ${stamp}`, description: `${caseId} 自动化测试拍品` },
  });
  const room = await must('/live-rooms', {
    method: 'POST',
    headers: authHeaders(admin),
    body: { title: `2.0 封顶成交一致性直播间 ${stamp}` },
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
  socket.on('auctionEnded', (payload) => {
    metrics.auctionEndedEvents += 1;
    metrics.auctionEnded = payload;
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
  const metrics = { initialSnapshot: null, bidAcceptedEvents: 0, lastBidAccepted: null, auctionEndedEvents: 0, auctionEnded: null };
  let observer;

  try {
    await waitForHealth();
    const admin = await login(`2.0 ${caseId} 主播`, 'ADMIN');
    const userA = await login(`2.0 ${caseId} 用户 A`, 'BIDDER');
    const userB = await login(`2.0 ${caseId} 用户 B`, 'BIDDER');
    const userWinner = await login(`2.0 ${caseId} 封顶用户`, 'BIDDER');
    const userAfterSold = await login(`2.0 ${caseId} 成交后出价用户`, 'BIDDER');
    const auction = await setupAuction(admin);
    observer = await connectObserver(auction.id, metrics);

    const preBids = [];
    for (let amount = 100; amount <= 900; amount += 100) {
      const bidder = amount % 200 === 0 ? userB : userA;
      preBids.push(await bid(auction.id, bidder, amount));
      await sleep(80);
    }
    const beforeCapMysql = await mysqlSnapshot(prisma, auction.id);
    const capBid = await bid(auction.id, userWinner, 1000);
    await sleep(1000);
    const afterSoldBid = await bid(auction.id, userAfterSold, 1100);

    const mysql = await mysqlSnapshot(prisma, auction.id);
    const redisState = await redisSnapshot(redis, auction.id);
    const httpDetail = await request(`/auctions/${auction.id}`);
    const httpLeaderboard = await request(`/auctions/${auction.id}/leaderboard`);
    const httpTop = httpLeaderboard.data?.leaderboard?.[0] ?? null;
    const wsTop = metrics.auctionEnded?.leaderboard?.[0] ?? null;

    const checks = {
      preBidsAllOk: preBids.every((item) => item.ok),
      beforeCapAt900: beforeCapMysql.status === 'RUNNING' && beforeCapMysql.currentPriceCent === 900,
      capBidOk: capBid.ok,
      afterSoldBidRejected: !afterSoldBid.ok && Number(afterSoldBid.status) < 500,
      statusAllSold: [mysql.status, redisState.status, httpDetail.data?.status, metrics.auctionEnded?.status].every((status) => status === 'SOLD'),
      priceAll1000: allEqual(
        mysql.currentPriceCent,
        mysql.highestBidAmountCent,
        mysql.orderAmountCent,
        redisState.currentPriceCent,
        redisState.leaderboardTopAmountCent,
        httpDetail.data?.currentPriceCent,
        httpDetail.data?.order?.amountCent,
        httpTop?.amountCent,
        metrics.auctionEnded?.currentPriceCent,
        wsTop?.amountCent,
      ) && mysql.currentPriceCent === 1000,
      winnerAllSame: allEqual(
        mysql.leaderUserId,
        mysql.highestBidUserId,
        mysql.orderWinnerUserId,
        redisState.leaderUserId,
        redisState.leaderboardTopUserId,
        httpDetail.data?.leaderUserId,
        httpDetail.data?.order?.winnerUserId,
        httpTop?.userId,
        metrics.auctionEnded?.leaderUserId,
        wsTop?.userId,
      ) && mysql.leaderUserId === userWinner.id,
      oneOrderOnly: mysql.orderCount === 1,
      bidCountIs10: mysql.bidCount === 10,
      websocketEndedReceived: metrics.auctionEndedEvents === 1,
      httpOk: httpDetail.ok && httpLeaderboard.ok,
      healthAfter: await healthOk(),
    };

    const result = {
      caseId,
      status: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL',
      generatedAt: new Date().toISOString(),
      auctionId: auction.id,
      apiWasRunning,
      preBids: preBids.map((item) => ({ ok: item.ok, status: item.status, latencyMs: Number(item.latencyMs.toFixed(2)) })),
      beforeCapMysql,
      capBid: { ok: capBid.ok, status: capBid.status, latencyMs: Number(capBid.latencyMs.toFixed(2)) },
      afterSoldBid: {
        ok: afterSoldBid.ok,
        status: afterSoldBid.status,
        message: afterSoldBid.data?.message ?? afterSoldBid.data?.error ?? null,
      },
      mysql,
      redis: redisState,
      http: {
        detailStatus: httpDetail.status,
        currentPriceCent: httpDetail.data?.currentPriceCent ?? null,
        leaderUserId: httpDetail.data?.leaderUserId ?? null,
        status: httpDetail.data?.status ?? null,
        orderAmountCent: httpDetail.data?.order?.amountCent ?? null,
        orderWinnerUserId: httpDetail.data?.order?.winnerUserId ?? null,
        leaderboardTopAmountCent: httpTop?.amountCent ?? null,
        leaderboardTopUserId: httpTop?.userId ?? null,
      },
      websocket: {
        bidAcceptedEvents: metrics.bidAcceptedEvents,
        auctionEndedEvents: metrics.auctionEndedEvents,
        currentPriceCent: metrics.auctionEnded?.currentPriceCent ?? null,
        leaderUserId: metrics.auctionEnded?.leaderUserId ?? null,
        status: metrics.auctionEnded?.status ?? null,
        orderAmountCent: metrics.auctionEnded?.order?.amountCent ?? null,
        orderWinnerUserId: metrics.auctionEnded?.order?.winnerUserId ?? null,
        leaderboardTopAmountCent: wsTop?.amountCent ?? null,
        leaderboardTopUserId: wsTop?.userId ?? null,
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
      `| 封顶前状态 | ${JSON.stringify(result.beforeCapMysql)} |`,
      `| 封顶出价 | ${JSON.stringify(result.capBid)} |`,
      `| 成交后继续出价 | ${JSON.stringify(result.afterSoldBid)} |`,
      `| MySQL | ${JSON.stringify(result.mysql)} |`,
      `| Redis | ${JSON.stringify(result.redis)} |`,
      `| HTTP | ${JSON.stringify(result.http)} |`,
      `| WebSocket | ${JSON.stringify(result.websocket)} |`,
      `| 检查项 | ${JSON.stringify(result.checks)} |`,
      '',
      result.status === 'PASS'
        ? '结论：`TC-CONSIST-002` 通过。封顶成交后 SOLD 状态、订单、最高出价、Redis、HTTP、WebSocket 成交事件一致，成交后继续出价被拒绝。'
        : '结论：`TC-CONSIST-002` 未通过。需要根据 SOLD 状态、订单归属、最高出价、Redis/HTTP/WebSocket 一致性或成交后拒绝出价定位问题。',
      '',
    ].join('\n'));

    console.log(JSON.stringify(result, null, 2));
  } finally {
    observer?.close();
    await redis.quit().catch(() => {});
    await prisma.$disconnect().catch(() => {});
    if (apiProcess) apiProcess.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
