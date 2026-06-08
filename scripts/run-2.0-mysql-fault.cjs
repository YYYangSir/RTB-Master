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

const caseId = args.get('case') ?? 'TC-FAULT-002';
const mysqlContainer = args.get('mysql-container') ?? 'auction-mysql';

function authHeaders(user) {
  return { Authorization: `Bearer ${user.token}` };
}

async function docker(args) {
  const result = await execFileAsync('docker', args, { timeout: 60_000 });
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

async function waitForMysql() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const prisma = new PrismaClient();
      await prisma.$queryRaw`SELECT 1`;
      await prisma.$disconnect();
      return;
    } catch {
      await sleep(1000);
    }
  }
  throw new Error('MySQL did not recover');
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
    body: { name: `2.0 MySQL 故障拍品 ${stamp}`, description: `${caseId} 自动化测试拍品` },
  });
  const room = await must('/live-rooms', {
    method: 'POST',
    headers: authHeaders(admin),
    body: { title: `2.0 MySQL 故障直播间 ${stamp}` },
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

function consistent(mysql, redis) {
  return (
    mysql.currentPriceCent === redis.currentPriceCent &&
    mysql.leaderUserId === redis.leaderUserId &&
    mysql.status === redis.status &&
    mysql.highestBidAmountCent === redis.leaderboardTopAmountCent &&
    mysql.highestBidUserId === redis.leaderboardTopUserId
  );
}

async function main() {
  await docker(['start', mysqlContainer]).catch(() => {});
  await waitForMysql();

  const apiWasRunning = await healthOk();
  const apiProcess = apiWasRunning
    ? null
    : spawn('pnpm', ['--filter', 'api-server', 'exec', 'node', 'dist/main.js'], {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['ignore', 'ignore', 'ignore'],
      });

  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', { maxRetriesPerRequest: 1 });
  let mysqlStopped = false;

  try {
    await waitForHealth();
    const admin = await login(`2.0 ${caseId} 主播`, 'ADMIN');
    const userA = await login(`2.0 ${caseId} 用户 A`, 'BIDDER');
    const userB = await login(`2.0 ${caseId} 用户 B`, 'BIDDER');
    const userC = await login(`2.0 ${caseId} 用户 C`, 'BIDDER');
    const auction = await setupAuction(admin);

    const initialBid = await bid(auction.id, userA, 100);
    let prisma = new PrismaClient();
    const beforeFaultMysql = await mysqlSnapshot(prisma, auction.id);
    await prisma.$disconnect();
    const beforeFaultRedis = await redisSnapshot(redis, auction.id);

    const stopOutput = await docker(['stop', mysqlContainer]);
    mysqlStopped = true;
    await sleep(2000);
    const faultBid = await bid(auction.id, userB, 200, 10000);
    const redisDuringFault = await redisSnapshot(redis, auction.id);

    const startOutput = await docker(['start', mysqlContainer]);
    mysqlStopped = false;
    await waitForMysql();
    await sleep(2000);

    prisma = new PrismaClient();
    const afterRecoveryMysql = await mysqlSnapshot(prisma, auction.id);
    await prisma.$disconnect();
    const afterRecoveryRedis = await redisSnapshot(redis, auction.id);

    const recoveryBid = await bid(auction.id, userC, 300, 10000);
    await sleep(1000);

    prisma = new PrismaClient();
    const finalMysql = await mysqlSnapshot(prisma, auction.id);
    await prisma.$disconnect();
    const finalRedis = await redisSnapshot(redis, auction.id);
    const httpDetail = await request(`/auctions/${auction.id}`, { timeoutMs: 5000 });
    const httpLeaderboard = await request(`/auctions/${auction.id}/leaderboard`, { timeoutMs: 5000 });
    const healthAfter = await healthOk();

    const redisAdvancedDuringMysqlFault = redisDuringFault.currentPriceCent !== beforeFaultRedis.currentPriceCent;
    const mysqlChangedDuringFaultAfterRecovery = (
      afterRecoveryMysql.currentPriceCent !== beforeFaultMysql.currentPriceCent ||
      afterRecoveryMysql.bidCount !== beforeFaultMysql.bidCount ||
      afterRecoveryMysql.orderCount !== beforeFaultMysql.orderCount
    );
    const inconsistentAfterRecovery = !consistent(afterRecoveryMysql, afterRecoveryRedis);
    const noFalseSuccess = !faultBid.ok;
    const noWrongOrder = finalMysql.orderCount === 0;
    const finalHttpConsistent = (
      httpDetail.ok &&
      httpLeaderboard.ok &&
      finalMysql.currentPriceCent === httpDetail.data.currentPriceCent &&
      finalMysql.leaderUserId === httpDetail.data.leaderUserId &&
      finalMysql.currentPriceCent === httpLeaderboard.data.leaderboard?.[0]?.amountCent &&
      finalMysql.leaderUserId === httpLeaderboard.data.leaderboard?.[0]?.userId
    );
    const finalConsistent = consistent(finalMysql, finalRedis) && finalHttpConsistent;

    const result = {
      caseId,
      status: (
        initialBid.ok &&
        noFalseSuccess &&
        !redisAdvancedDuringMysqlFault &&
        !mysqlChangedDuringFaultAfterRecovery &&
        !inconsistentAfterRecovery &&
        recoveryBid.ok &&
        finalConsistent &&
        noWrongOrder &&
        healthAfter
      ) ? 'PASS' : 'FAIL',
      generatedAt: new Date().toISOString(),
      auctionId: auction.id,
      apiWasRunning,
      mysqlContainer,
      docker: { stopOutput, startOutput },
      initialBid: { ok: initialBid.ok, status: initialBid.status, latencyMs: Number(initialBid.latencyMs.toFixed(2)) },
      beforeFaultMysql,
      beforeFaultRedis,
      faultBid: {
        ok: faultBid.ok,
        status: faultBid.status,
        latencyMs: Number(faultBid.latencyMs.toFixed(2)),
        message: faultBid.data?.message ?? faultBid.data?.error ?? null,
      },
      redisDuringFault,
      afterRecoveryMysql,
      afterRecoveryRedis,
      recoveryBid: {
        ok: recoveryBid.ok,
        status: recoveryBid.status,
        latencyMs: Number(recoveryBid.latencyMs.toFixed(2)),
        message: recoveryBid.data?.message ?? recoveryBid.data?.error ?? null,
      },
      finalMysql,
      finalRedis,
      finalHttp: {
        ok: httpDetail.ok,
        statusCode: httpDetail.status,
        currentPriceCent: httpDetail.data?.currentPriceCent ?? null,
        leaderUserId: httpDetail.data?.leaderUserId ?? null,
        leaderboardTopUserId: httpLeaderboard.data?.leaderboard?.[0]?.userId ?? null,
        leaderboardTopAmountCent: httpLeaderboard.data?.leaderboard?.[0]?.amountCent ?? null,
      },
      checks: {
        noFalseSuccess,
        redisAdvancedDuringMysqlFault,
        mysqlChangedDuringFaultAfterRecovery,
        inconsistentAfterRecovery,
        recoveryBidOk: recoveryBid.ok,
        finalConsistent,
        noWrongOrder,
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
      `| MySQL 故障方式 | docker stop/start ${result.mysqlContainer} |`,
      `| 故障前 MySQL | ${JSON.stringify(result.beforeFaultMysql)} |`,
      `| 故障前 Redis | ${JSON.stringify(result.beforeFaultRedis)} |`,
      `| 故障期间出价 | ${JSON.stringify(result.faultBid)} |`,
      `| 故障期间 Redis | ${JSON.stringify(result.redisDuringFault)} |`,
      `| 恢复后 MySQL | ${JSON.stringify(result.afterRecoveryMysql)} |`,
      `| 恢复后 Redis | ${JSON.stringify(result.afterRecoveryRedis)} |`,
      `| 再次正常出价 | ${JSON.stringify(result.recoveryBid)} |`,
      `| 最终 MySQL | ${JSON.stringify(result.finalMysql)} |`,
      `| 最终 Redis | ${JSON.stringify(result.finalRedis)} |`,
      `| 最终 HTTP | ${JSON.stringify(result.finalHttp)} |`,
      `| 检查项 | ${JSON.stringify(result.checks)} |`,
      '',
      result.status === 'PASS'
        ? '结论：`TC-FAULT-002` 通过，MySQL 写入失败期间未出现 Redis 成功但 MySQL 无记录的问题，恢复后系统一致。'
        : '结论：`TC-FAULT-002` 未通过，已发现 MySQL 写入失败场景下 Redis / MySQL 状态不一致或恢复后仍不一致，应暂停后续故障项并优先修复。',
      '',
    ].join('\n'));

    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (mysqlStopped) {
      await docker(['start', mysqlContainer]).catch(() => {});
      await waitForMysql().catch(() => {});
    }
    await redis.quit().catch(() => {});
    if (apiProcess) apiProcess.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
