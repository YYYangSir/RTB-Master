const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { setTimeout: sleep } = require('node:timers/promises');
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

const caseId = args.get('case') ?? 'TC-FAULT-004';

function authHeaders(user) {
  return { Authorization: `Bearer ${user.token}` };
}

async function request(path, { method = 'GET', body, headers, timeoutMs = 10000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${api}${path}`, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    return { ok: response.ok, status: response.status, data: await response.json().catch(() => ({})) };
  } catch (error) {
    return { ok: false, status: 'CLIENT_ERROR', data: { message: error.message } };
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
    body: { name: `2.0 订单失败拍品 ${stamp}`, description: `${caseId} 自动化测试拍品` },
  });
  const room = await must('/live-rooms', {
    method: 'POST',
    headers: authHeaders(admin),
    body: { title: `2.0 订单失败直播间 ${stamp}` },
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
    },
  });
  await must(`/auctions/${auction.id}/start`, { method: 'POST', headers: authHeaders(admin) });
  return auction;
}

async function bid(auctionId, user, amountCent) {
  return request(`/auctions/${auctionId}/bids`, {
    method: 'POST',
    headers: authHeaders(user),
    body: { requestId: randomUUID(), userId: user.id, amountCent },
  });
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

async function main() {
  const apiWasRunning = await healthOk();
  if (apiWasRunning) {
    throw new Error('API is already running; stop it before TC-FAULT-004 so the test can enable order failure injection');
  }

  const apiProcess = spawn('pnpm', ['--filter', 'api-server', 'exec', 'node', 'dist/main.js'], {
    cwd: process.cwd(),
    env: { ...process.env, AUCTION_TEST_FAIL_ORDER_CREATE: '1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const prisma = new PrismaClient();
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', { maxRetriesPerRequest: 1 });

  try {
    await waitForHealth();
    const admin = await login(`2.0 ${caseId} 主播`, 'ADMIN');
    const userA = await login(`2.0 ${caseId} 用户 A`, 'BIDDER');
    const userB = await login(`2.0 ${caseId} 用户 B`, 'BIDDER');
    const auction = await setupAuction(admin);

    const preBid = await bid(auction.id, userA, 900);
    const beforeFailureMysql = await mysqlSnapshot(prisma, auction.id);
    const beforeFailureRedis = await redisSnapshot(redis, auction.id);
    const capBid = await bid(auction.id, userB, 1000);
    await sleep(1000);

    const mysql = await mysqlSnapshot(prisma, auction.id);
    const redisState = await redisSnapshot(redis, auction.id);
    const httpDetail = await request(`/auctions/${auction.id}`);
    const httpLeaderboard = await request(`/auctions/${auction.id}/leaderboard`);
    const healthAfter = await healthOk();

    const soldWithoutOrder = (
      mysql.status === 'SOLD' && mysql.orderCount === 0
    ) || (
      redisState.status === 'SOLD' && mysql.orderCount === 0
    ) || (
      httpDetail.data?.status === 'SOLD' && !httpDetail.data?.order
    );
    const redisMysqlDiverged = (
      mysql.currentPriceCent !== redisState.currentPriceCent ||
      mysql.leaderUserId !== redisState.leaderUserId ||
      mysql.status !== redisState.status
    );
    const httpShowsFalseSold = httpDetail.data?.status === 'SOLD' && !httpDetail.data?.order;
    const noDuplicateOrder = mysql.orderCount <= 1;
    const acceptableFailureState = (
      !capBid.ok &&
      !soldWithoutOrder &&
      !redisMysqlDiverged &&
      noDuplicateOrder
    );

    const result = {
      caseId,
      status: acceptableFailureState && healthAfter ? 'PASS' : 'FAIL',
      generatedAt: new Date().toISOString(),
      auctionId: auction.id,
      apiWasRunning,
      injection: 'AUCTION_TEST_FAIL_ORDER_CREATE=1',
      preBid: {
        ok: preBid.ok,
        status: preBid.status,
        currentPriceCent: preBid.data?.snapshot?.currentPriceCent ?? preBid.data?.currentPriceCent ?? null,
      },
      beforeFailureMysql,
      beforeFailureRedis,
      capBid: {
        ok: capBid.ok,
        status: capBid.status,
        message: capBid.data?.message ?? capBid.data?.error ?? null,
      },
      mysql,
      redis: redisState,
      http: {
        ok: httpDetail.ok,
        statusCode: httpDetail.status,
        currentPriceCent: httpDetail.data?.currentPriceCent ?? null,
        leaderUserId: httpDetail.data?.leaderUserId ?? null,
        status: httpDetail.data?.status ?? null,
        hasOrder: Boolean(httpDetail.data?.order),
        leaderboardTopUserId: httpLeaderboard.data?.leaderboard?.[0]?.userId ?? null,
        leaderboardTopAmountCent: httpLeaderboard.data?.leaderboard?.[0]?.amountCent ?? null,
      },
      checks: {
        capBidRejected: !capBid.ok,
        soldWithoutOrder,
        redisMysqlDiverged,
        httpShowsFalseSold,
        noDuplicateOrder,
        acceptableFailureState,
        healthAfter,
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
      `| 故障注入 | ${result.injection} |`,
      `| 故障前 MySQL | ${JSON.stringify(result.beforeFailureMysql)} |`,
      `| 故障前 Redis | ${JSON.stringify(result.beforeFailureRedis)} |`,
      `| 封顶出价结果 | ${JSON.stringify(result.capBid)} |`,
      `| 故障后 MySQL | ${JSON.stringify(result.mysql)} |`,
      `| 故障后 Redis | ${JSON.stringify(result.redis)} |`,
      `| 故障后 HTTP | ${JSON.stringify(result.http)} |`,
      `| 检查项 | ${JSON.stringify(result.checks)} |`,
      '',
      result.status === 'PASS'
        ? '结论：`TC-FAULT-004` 通过，订单生成失败时未出现 SOLD 无订单、Redis/MySQL 分歧或前端虚假成交。'
        : '结论：`TC-FAULT-004` 未通过，订单生成失败后出现 SOLD 无订单、Redis/MySQL 分歧或前端虚假成交，应暂停后续故障项并优先修复成交事务补偿/回滚问题。',
      '',
    ].join('\n'));

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await redis.quit().catch(() => {});
    await prisma.$disconnect().catch(() => {});
    apiProcess.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
