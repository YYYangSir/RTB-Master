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

const caseId = args.get('case') ?? 'TC-CONSIST-001';
const users = Number(args.get('users') ?? 100);
const rounds = Number(args.get('rounds') ?? 10);
const incrementCent = 100;
const capPriceCent = rounds * incrementCent;

function authHeaders(user) {
  return { Authorization: `Bearer ${user.token}` };
}

async function request(path, { method = 'GET', body, headers } = {}) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    ok: response.ok,
    status: response.status,
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
    body: { name: `2.0 一致性拍品 ${stamp}`, description: `${caseId} 自动化测试拍品` },
  });
  const room = await must('/live-rooms', {
    method: 'POST',
    headers: authHeaders(admin),
    body: { title: `2.0 一致性直播间 ${stamp}` },
  });
  const auction = await must('/auctions', {
    method: 'POST',
    headers: authHeaders(admin),
    body: {
      productId: product.id,
      liveRoomId: room.id,
      startPriceCent: 0,
      incrementCent,
      capPriceCent,
      durationSec: 600,
      extensionWindowSec: 30,
      extensionSec: 30,
    },
  });
  await must(`/auctions/${auction.id}/start`, { method: 'POST', headers: authHeaders(admin) });
  return auction;
}

async function connectObserver(auctionId, metrics) {
  const socket = io(base, { transports: ['websocket'], reconnection: false, timeout: 10000 });
  socket.on('auctionSnapshot', (payload) => {
    metrics.wsSnapshot = payload;
  });
  socket.on('bidAccepted', (payload) => {
    metrics.wsSnapshot = payload;
    metrics.bidAcceptedEvents += 1;
  });
  socket.on('auctionEnded', (payload) => {
    metrics.wsSnapshot = payload;
    metrics.auctionEndedEvents += 1;
  });
  await new Promise((resolve) => {
    socket.once('connect', resolve);
    socket.once('connect_error', resolve);
  });
  if (!socket.connected) throw new Error('observer socket did not connect');
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000);
    socket.once('auctionSnapshot', (payload) => {
      metrics.wsSnapshot = payload;
      clearTimeout(timer);
      resolve();
    });
    socket.emit('joinAuction', { auctionId });
  });
  return socket;
}

async function runConcurrentRound(auctionId, bidders, amountCent) {
  const results = await Promise.all(bidders.map((user) => request(`/auctions/${auctionId}/bids`, {
    method: 'POST',
    headers: authHeaders(user),
    body: { requestId: randomUUID(), userId: user.id, amountCent },
  })));
  return {
    targetAmountCent: amountCent,
    success: results.filter((item) => item.ok).length,
    businessRejects: results.filter((item) => !item.ok && item.status < 500).length,
    systemErrors: results.filter((item) => item.status >= 500).length,
    statuses: results.reduce((acc, item) => {
      acc[item.status] = (acc[item.status] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

async function waitForStatus(auctionId, expectedStatus) {
  for (let i = 0; i < 60; i += 1) {
    const detail = await must(`/auctions/${auctionId}`);
    if (detail.status === expectedStatus) return detail;
    await sleep(500);
  }
  return must(`/auctions/${auctionId}`);
}

function samePrice(...values) {
  return values.every((value) => value === values[0]);
}

function sameUser(...values) {
  return values.every((value) => value && value === values[0]);
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
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', { maxRetriesPerRequest: 2 });
  const metrics = { wsSnapshot: null, bidAcceptedEvents: 0, auctionEndedEvents: 0 };
  let observer;

  try {
    await waitForHealth();
    const admin = await login(`2.0 ${caseId} 主播`, 'ADMIN');
    const bidders = [];
    for (let i = 0; i < users; i += 1) {
      bidders.push(await login(`2.0 ${caseId} 用户 ${String(i + 1).padStart(3, '0')}`, 'BIDDER'));
    }
    const auction = await setupAuction(admin);
    observer = await connectObserver(auction.id, metrics);

    const roundsResult = [];
    for (let round = 1; round <= rounds; round += 1) {
      roundsResult.push(await runConcurrentRound(auction.id, bidders, round * incrementCent));
      await sleep(300);
    }

    const httpDetail = await waitForStatus(auction.id, 'SOLD');
    await sleep(1000);
    const httpLeaderboard = await must(`/auctions/${auction.id}/leaderboard`);
    const mysqlAuction = await prisma.auction.findUniqueOrThrow({
      where: { id: auction.id },
      include: { order: true },
    });
    const mysqlHighestBid = await prisma.bid.findFirst({
      where: { auctionId: auction.id },
      orderBy: { amountCent: 'desc' },
    });
    const mysqlBidCount = await prisma.bid.count({ where: { auctionId: auction.id } });
    const mysqlOrderCount = await prisma.order.count({ where: { auctionId: auction.id } });
    const redisState = await redis.hgetall(`auction:${auction.id}:state`);
    const redisTop = await redis.zrevrange(`auction:${auction.id}:leaderboard`, 0, 0, 'WITHSCORES');
    const wsTop = metrics.wsSnapshot?.leaderboard?.[0] ?? null;
    const httpTop = httpLeaderboard.leaderboard?.[0] ?? null;

    const totalSuccess = roundsResult.reduce((sum, item) => sum + item.success, 0);
    const totalSystemErrors = roundsResult.reduce((sum, item) => sum + item.systemErrors, 0);
    const perRoundAtMostOneSuccess = roundsResult.every((item) => item.success <= 1);
    const priceConsistent = samePrice(
      mysqlAuction.currentPriceCent,
      mysqlHighestBid?.amountCent,
      mysqlAuction.order?.amountCent,
      Number(redisState.currentPriceCent),
      Number(redisTop[1]),
      httpDetail.currentPriceCent,
      httpTop?.amountCent,
      metrics.wsSnapshot?.currentPriceCent,
      wsTop?.amountCent,
    );
    const leaderConsistent = sameUser(
      mysqlAuction.leaderUserId,
      mysqlHighestBid?.userId,
      mysqlAuction.order?.winnerUserId,
      redisState.leaderUserId,
      redisTop[0],
      httpDetail.leaderUserId,
      httpTop?.userId,
      metrics.wsSnapshot?.leaderUserId,
      wsTop?.userId,
    );
    const statusConsistent = [mysqlAuction.status, redisState.status, httpDetail.status, metrics.wsSnapshot?.status]
      .every((status) => status === 'SOLD');
    const orderConsistent = mysqlOrderCount === 1 && Boolean(httpDetail.order);

    const result = {
      caseId,
      status: (
        perRoundAtMostOneSuccess &&
        totalSuccess === rounds &&
        totalSystemErrors === 0 &&
        mysqlBidCount === rounds &&
        priceConsistent &&
        leaderConsistent &&
        statusConsistent &&
        orderConsistent
      ) ? 'PASS' : 'FAIL',
      generatedAt: new Date().toISOString(),
      users,
      rounds,
      incrementCent,
      capPriceCent,
      auctionId: auction.id,
      apiWasRunning,
      roundsResult,
      totalSuccess,
      totalSystemErrors,
      mysqlBidCount,
      mysqlOrderCount,
      wsBidAcceptedEvents: metrics.bidAcceptedEvents,
      wsAuctionEndedEvents: metrics.auctionEndedEvents,
      mysql: {
        currentPriceCent: mysqlAuction.currentPriceCent,
        leaderUserId: mysqlAuction.leaderUserId,
        status: mysqlAuction.status,
        highestBidAmountCent: mysqlHighestBid?.amountCent ?? null,
        highestBidUserId: mysqlHighestBid?.userId ?? null,
        orderAmountCent: mysqlAuction.order?.amountCent ?? null,
        orderWinnerUserId: mysqlAuction.order?.winnerUserId ?? null,
      },
      redis: {
        currentPriceCent: Number(redisState.currentPriceCent),
        leaderUserId: redisState.leaderUserId,
        status: redisState.status,
        leaderboardTopUserId: redisTop[0] ?? null,
        leaderboardTopAmountCent: redisTop[1] ? Number(redisTop[1]) : null,
      },
      http: {
        currentPriceCent: httpDetail.currentPriceCent,
        leaderUserId: httpDetail.leaderUserId,
        status: httpDetail.status,
        orderAmountCent: httpDetail.order?.amountCent ?? null,
        orderWinnerUserId: httpDetail.order?.winnerUserId ?? null,
        leaderboardTopUserId: httpTop?.userId ?? null,
        leaderboardTopAmountCent: httpTop?.amountCent ?? null,
      },
      websocket: {
        currentPriceCent: metrics.wsSnapshot?.currentPriceCent ?? null,
        leaderUserId: metrics.wsSnapshot?.leaderUserId ?? null,
        status: metrics.wsSnapshot?.status ?? null,
        leaderboardTopUserId: wsTop?.userId ?? null,
        leaderboardTopAmountCent: wsTop?.amountCent ?? null,
      },
      checks: {
        perRoundAtMostOneSuccess,
        totalSuccessEqualsRounds: totalSuccess === rounds,
        noSystemErrors: totalSystemErrors === 0,
        mysqlBidCountEqualsRounds: mysqlBidCount === rounds,
        priceConsistent,
        leaderConsistent,
        statusConsistent,
        orderConsistent,
      },
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
      `| 并发模型 | ${result.rounds} 轮，每轮 ${result.users} 用户同时出价 |`,
      `| 成功出价 | ${result.totalSuccess}/${result.rounds} |`,
      `| 系统 5xx | ${result.totalSystemErrors} |`,
      `| MySQL 出价记录 | ${result.mysqlBidCount} |`,
      `| MySQL 订单记录 | ${result.mysqlOrderCount} |`,
      `| WebSocket 事件 | bidAccepted ${result.wsBidAcceptedEvents}，auctionEnded ${result.wsAuctionEndedEvents} |`,
      `| MySQL | ${JSON.stringify(result.mysql)} |`,
      `| Redis | ${JSON.stringify(result.redis)} |`,
      `| HTTP | ${JSON.stringify(result.http)} |`,
      `| WebSocket | ${JSON.stringify(result.websocket)} |`,
      `| 检查项 | ${JSON.stringify(result.checks)} |`,
      '',
      result.status === 'PASS'
        ? '结论：`TC-CONSIST-001` 通过，并发出价后 MySQL、Redis、HTTP 和 WebSocket 前端快照一致。'
        : '结论：`TC-CONSIST-001` 未通过，需要根据检查项定位并发互斥或跨层状态同步问题。',
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
