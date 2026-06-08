const { spawn, execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { promisify } = require('node:util');
const { setTimeout: sleep } = require('node:timers/promises');
const Redis = require('../apps/api-server/node_modules/ioredis');
const { PrismaClient } = require('../apps/api-server/node_modules/@prisma/client');

const execFileAsync = promisify(execFile);
const base = 'http://127.0.0.1:3000';
const api = `${base}/api`;
const reportDir = 'reports';
mkdirSync(reportDir, { recursive: true });

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));

const caseId = args.get('case') ?? 'TC-FAULT-001';
const redisContainer = args.get('redis-container') ?? 'auction-redis';

function authHeaders(user) {
  return { Authorization: `Bearer ${user.token}` };
}

async function docker(args) {
  const result = await execFileAsync('docker', args, { timeout: 30_000 });
  return `${result.stdout}${result.stderr}`.trim();
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
  try {
    return (await request('/health', { timeoutMs: 2000 })).ok;
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

async function waitForRedis() {
  for (let i = 0; i < 40; i += 1) {
    const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', { maxRetriesPerRequest: 1 });
    try {
      if (await redis.ping() === 'PONG') {
        await redis.quit();
        return;
      }
    } catch {
      await redis.disconnect();
    }
    await sleep(500);
  }
  throw new Error('Redis did not recover');
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
    body: { name: `2.0 Redis 故障拍品 ${stamp}`, description: `${caseId} 自动化测试拍品` },
  });
  const room = await must('/live-rooms', {
    method: 'POST',
    headers: authHeaders(admin),
    body: { title: `2.0 Redis 故障直播间 ${stamp}` },
  });
  const auction = await must('/auctions', {
    method: 'POST',
    headers: authHeaders(admin),
    body: {
      productId: product.id,
      liveRoomId: room.id,
      startPriceCent: 0,
      incrementCent: 100,
      capPriceCent: 100000,
      durationSec: 600,
    },
  });
  await must(`/auctions/${auction.id}/start`, { method: 'POST', headers: authHeaders(admin) });
  return auction;
}

async function bid(auctionId, user, amountCent, timeoutMs = 10_000) {
  return request(`/auctions/${auctionId}/bids`, {
    method: 'POST',
    headers: authHeaders(user),
    body: { requestId: randomUUID(), userId: user.id, amountCent },
    timeoutMs,
  });
}

async function snapshot(prisma, redis, auctionId) {
  const [mysqlAuction, mysqlBidCount, mysqlOrderCount, httpDetail, httpLeaderboard] = await Promise.all([
    prisma.auction.findUniqueOrThrow({ where: { id: auctionId }, include: { order: true } }),
    prisma.bid.count({ where: { auctionId } }),
    prisma.order.count({ where: { auctionId } }),
    request(`/auctions/${auctionId}`, { timeoutMs: 5000 }),
    request(`/auctions/${auctionId}/leaderboard`, { timeoutMs: 5000 }),
  ]);
  let redisState = null;
  let redisTop = [];
  try {
    redisState = await redis.hgetall(`auction:${auctionId}:state`);
    redisTop = await redis.zrevrange(`auction:${auctionId}:leaderboard`, 0, 0, 'WITHSCORES');
  } catch (error) {
    redisState = { error: error.message };
  }
  return {
    mysql: {
      currentPriceCent: mysqlAuction.currentPriceCent,
      leaderUserId: mysqlAuction.leaderUserId,
      status: mysqlAuction.status,
      bidCount: mysqlBidCount,
      orderCount: mysqlOrderCount,
      orderAmountCent: mysqlAuction.order?.amountCent ?? null,
      orderWinnerUserId: mysqlAuction.order?.winnerUserId ?? null,
    },
    redis: {
      currentPriceCent: redisState?.currentPriceCent ? Number(redisState.currentPriceCent) : null,
      leaderUserId: redisState?.leaderUserId || null,
      status: redisState?.status ?? null,
      error: redisState?.error,
      leaderboardTopUserId: redisTop[0] ?? null,
      leaderboardTopAmountCent: redisTop[1] ? Number(redisTop[1]) : null,
    },
    http: {
      ok: httpDetail.ok,
      statusCode: httpDetail.status,
      currentPriceCent: httpDetail.data?.currentPriceCent ?? null,
      leaderUserId: httpDetail.data?.leaderUserId ?? null,
      status: httpDetail.data?.status ?? null,
      orderAmountCent: httpDetail.data?.order?.amountCent ?? null,
      orderWinnerUserId: httpDetail.data?.order?.winnerUserId ?? null,
      leaderboardTopUserId: httpLeaderboard.data?.leaderboard?.[0]?.userId ?? null,
      leaderboardTopAmountCent: httpLeaderboard.data?.leaderboard?.[0]?.amountCent ?? null,
    },
  };
}

function restoredConsistency(snap) {
  return (
    snap.mysql.currentPriceCent === snap.redis.currentPriceCent &&
    snap.mysql.currentPriceCent === snap.http.currentPriceCent &&
    snap.mysql.currentPriceCent === snap.redis.leaderboardTopAmountCent &&
    snap.mysql.currentPriceCent === snap.http.leaderboardTopAmountCent &&
    snap.mysql.leaderUserId === snap.redis.leaderUserId &&
    snap.mysql.leaderUserId === snap.http.leaderUserId &&
    snap.mysql.leaderUserId === snap.redis.leaderboardTopUserId &&
    snap.mysql.leaderUserId === snap.http.leaderboardTopUserId
  );
}

async function main() {
  await docker(['start', redisContainer]).catch(() => {});
  await waitForRedis();

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
  let redisStopped = false;

  try {
    await waitForHealth();
    const admin = await login(`2.0 ${caseId} 主播`, 'ADMIN');
    const userA = await login(`2.0 ${caseId} 用户 A`, 'BIDDER');
    const userB = await login(`2.0 ${caseId} 用户 B`, 'BIDDER');
    const userC = await login(`2.0 ${caseId} 用户 C`, 'BIDDER');
    const auction = await setupAuction(admin);

    const initialBid = await bid(auction.id, userA, 100);
    const beforeFault = await snapshot(prisma, redis, auction.id);

    const stopOutput = await docker(['stop', redisContainer]);
    redisStopped = true;
    await sleep(2000);
    const faultBidB = await bid(auction.id, userB, 200, 8000);
    const faultBidC = await bid(auction.id, userC, 300, 8000);
    const duringFaultMysql = {
      auction: await prisma.auction.findUniqueOrThrow({ where: { id: auction.id } }),
      bidCount: await prisma.bid.count({ where: { auctionId: auction.id } }),
      orderCount: await prisma.order.count({ where: { auctionId: auction.id } }),
    };

    const startOutput = await docker(['start', redisContainer]);
    redisStopped = false;
    await waitForRedis();
    await sleep(2000);

    const afterRecoveryBeforeBid = await snapshot(prisma, redis, auction.id);
    const recoveryBid = await bid(auction.id, userB, 200, 10000);
    await sleep(1000);
    const afterRecoveryBid = await snapshot(prisma, redis, auction.id);
    const healthAfter = await healthOk();

    const faultBidsReturnedSuccess = [faultBidB, faultBidC].filter((item) => item.ok).length;
    const noDirtyDuringFault = (
      faultBidsReturnedSuccess === 0 &&
      duringFaultMysql.auction.currentPriceCent === beforeFault.mysql.currentPriceCent &&
      duringFaultMysql.auction.leaderUserId === beforeFault.mysql.leaderUserId &&
      duringFaultMysql.bidCount === beforeFault.mysql.bidCount &&
      duringFaultMysql.orderCount === beforeFault.mysql.orderCount
    );
    const recoveryOk = recoveryBid.ok && afterRecoveryBid.mysql.currentPriceCent === 200;
    const consistencyOk = restoredConsistency(afterRecoveryBid);

    const result = {
      caseId,
      status: (
        initialBid.ok &&
        noDirtyDuringFault &&
        recoveryOk &&
        consistencyOk &&
        afterRecoveryBid.mysql.orderCount === 0 &&
        healthAfter
      ) ? 'PASS' : 'FAIL',
      generatedAt: new Date().toISOString(),
      auctionId: auction.id,
      apiWasRunning,
      redisContainer,
      docker: { stopOutput, startOutput },
      initialBid: { ok: initialBid.ok, status: initialBid.status, latencyMs: Number(initialBid.latencyMs.toFixed(2)) },
      beforeFault,
      faultBids: [
        { ok: faultBidB.ok, status: faultBidB.status, latencyMs: Number(faultBidB.latencyMs.toFixed(2)), message: faultBidB.data?.message ?? faultBidB.data?.error ?? null },
        { ok: faultBidC.ok, status: faultBidC.status, latencyMs: Number(faultBidC.latencyMs.toFixed(2)), message: faultBidC.data?.message ?? faultBidC.data?.error ?? null },
      ],
      duringFaultMysql: {
        currentPriceCent: duringFaultMysql.auction.currentPriceCent,
        leaderUserId: duringFaultMysql.auction.leaderUserId,
        status: duringFaultMysql.auction.status,
        bidCount: duringFaultMysql.bidCount,
        orderCount: duringFaultMysql.orderCount,
      },
      afterRecoveryBeforeBid,
      recoveryBid: { ok: recoveryBid.ok, status: recoveryBid.status, latencyMs: Number(recoveryBid.latencyMs.toFixed(2)), message: recoveryBid.data?.message ?? recoveryBid.data?.error ?? null },
      afterRecoveryBid,
      checks: {
        noFaultBidSuccess: faultBidsReturnedSuccess === 0,
        noDirtyDuringFault,
        recoveryOk,
        consistencyOk,
        noDuplicateOrder: afterRecoveryBid.mysql.orderCount === 0,
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
      `| Redis 故障方式 | docker stop/start ${result.redisContainer} |`,
      `| 故障前状态 | ${JSON.stringify(result.beforeFault.mysql)} |`,
      `| 故障期间出价 | ${JSON.stringify(result.faultBids)} |`,
      `| 故障期间 MySQL | ${JSON.stringify(result.duringFaultMysql)} |`,
      `| 恢复后正常出价 | ${JSON.stringify(result.recoveryBid)} |`,
      `| 恢复后 MySQL | ${JSON.stringify(result.afterRecoveryBid.mysql)} |`,
      `| 恢复后 Redis | ${JSON.stringify(result.afterRecoveryBid.redis)} |`,
      `| 恢复后 HTTP | ${JSON.stringify(result.afterRecoveryBid.http)} |`,
      `| 检查项 | ${JSON.stringify(result.checks)} |`,
      '',
      result.status === 'PASS'
        ? '结论：`TC-FAULT-001` 通过，Redis 暂时不可用期间出价被拒绝且未产生脏数据，Redis 恢复后系统可继续竞拍并保持一致。'
        : '结论：`TC-FAULT-001` 未通过，需要根据故障期间返回、MySQL 状态或恢复后一致性定位问题。',
      '',
    ].join('\n'));

    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (redisStopped) {
      await docker(['start', redisContainer]).catch(() => {});
      await waitForRedis().catch(() => {});
    }
    await redis.quit().catch(() => {});
    await prisma.$disconnect().catch(() => {});
    if (apiProcess) apiProcess.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
