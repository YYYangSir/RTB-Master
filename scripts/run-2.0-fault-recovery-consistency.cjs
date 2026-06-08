const { spawn, execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { promisify } = require('node:util');
const { setTimeout: sleep } = require('node:timers/promises');
const { io } = require('../apps/user-web/node_modules/socket.io-client');
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

const caseId = args.get('case') ?? 'TC-CONSIST-005';
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

async function waitForMysql() {
  for (let i = 0; i < 80; i += 1) {
    const prisma = new PrismaClient();
    try {
      await prisma.$queryRaw`SELECT 1`;
      return;
    } catch {
      await sleep(1000);
    } finally {
      await prisma.$disconnect().catch(() => {});
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
    body: { name: `2.0 故障恢复一致性拍品 ${stamp}`, description: `${caseId} 自动化测试拍品` },
  });
  const room = await must('/live-rooms', {
    method: 'POST',
    headers: authHeaders(admin),
    body: { title: `2.0 故障恢复一致性直播间 ${stamp}` },
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

async function connectAndJoin(auctionId, user) {
  const socket = io(base, { transports: ['websocket'], reconnection: false, timeout: 10_000 });
  let bidAccepted = null;
  socket.on('bidAccepted', (payload) => {
    bidAccepted = payload;
  });
  await new Promise((resolve) => {
    socket.once('connect', resolve);
    socket.once('connect_error', resolve);
  });
  if (!socket.connected) return { socket, connected: false, snapshot: null, getBidAccepted: () => bidAccepted };
  const snapshot = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 3000);
    socket.once('auctionSnapshot', (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
    socket.emit('joinAuction', { auctionId, userId: user.id, token: user.token });
  });
  return { socket, connected: true, snapshot, getBidAccepted: () => bidAccepted };
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

function backendConsistent(mysql, redis) {
  return (
    mysql.currentPriceCent === redis.currentPriceCent &&
    mysql.leaderUserId === redis.leaderUserId &&
    mysql.status === redis.status &&
    mysql.highestBidAmountCent === redis.leaderboardTopAmountCent &&
    mysql.highestBidUserId === redis.leaderboardTopUserId
  );
}

function httpConsistent(mysql, detail, leaderboard) {
  return (
    detail.ok &&
    leaderboard.ok &&
    mysql.currentPriceCent === detail.data.currentPriceCent &&
    mysql.leaderUserId === detail.data.leaderUserId &&
    mysql.status === detail.data.status &&
    mysql.currentPriceCent === leaderboard.data.leaderboard?.[0]?.amountCent &&
    mysql.leaderUserId === leaderboard.data.leaderboard?.[0]?.userId
  );
}

function snapshotConsistent(snapshot, mysql) {
  const top = snapshot?.leaderboard?.[0];
  return (
    snapshot?.currentPriceCent === mysql.currentPriceCent &&
    snapshot?.leaderUserId === mysql.leaderUserId &&
    snapshot?.status === mysql.status &&
    top?.amountCent === mysql.highestBidAmountCent &&
    top?.userId === mysql.highestBidUserId
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
  const sockets = [];
  let mysqlStopped = false;

  try {
    await waitForHealth();
    const admin = await login(`2.0 ${caseId} 主播`, 'ADMIN');
    const userA = await login(`2.0 ${caseId} 用户 A`, 'BIDDER');
    const userB = await login(`2.0 ${caseId} 用户 B`, 'BIDDER');
    const userC = await login(`2.0 ${caseId} 用户 C`, 'BIDDER');
    const auction = await setupAuction(admin);

    const initialBid = await bid(auction.id, userA, 100);
    await sleep(500);
    let prisma = new PrismaClient();
    const beforeFaultMysql = await mysqlSnapshot(prisma, auction.id);
    await prisma.$disconnect();
    const beforeFaultRedis = await redisSnapshot(redis, auction.id);

    const stopOutput = await docker(['stop', mysqlContainer]);
    mysqlStopped = true;
    await sleep(2000);
    const faultBid = await bid(auction.id, userB, 200, 10_000);
    const redisDuringFault = await redisSnapshot(redis, auction.id);

    const startOutput = await docker(['start', mysqlContainer]);
    mysqlStopped = false;
    await waitForMysql();
    await sleep(2000);

    prisma = new PrismaClient();
    const afterRecoveryMysql = await mysqlSnapshot(prisma, auction.id);
    await prisma.$disconnect();
    const afterRecoveryRedis = await redisSnapshot(redis, auction.id);

    const rejoinClient = await connectAndJoin(auction.id, userC);
    sockets.push(rejoinClient.socket);
    const afterRecoveryDetail = await request(`/auctions/${auction.id}`);
    const afterRecoveryLeaderboard = await request(`/auctions/${auction.id}/leaderboard`);

    const recoveryBid = await bid(auction.id, userC, 300);
    await sleep(800);

    prisma = new PrismaClient();
    const finalMysql = await mysqlSnapshot(prisma, auction.id);
    await prisma.$disconnect();
    const finalRedis = await redisSnapshot(redis, auction.id);
    const finalDetail = await request(`/auctions/${auction.id}`);
    const finalLeaderboard = await request(`/auctions/${auction.id}/leaderboard`);
    const finalSocketBroadcast = rejoinClient.getBidAccepted();
    const healthAfter = await healthOk();

    const checks = {
      initialBidOk: initialBid.ok,
      faultBidRejected: !faultBid.ok,
      redisNotAdvancedDuringFault: redisDuringFault.currentPriceCent === beforeFaultRedis.currentPriceCent,
      mysqlNotDirtyAfterRecovery: (
        afterRecoveryMysql.currentPriceCent === beforeFaultMysql.currentPriceCent &&
        afterRecoveryMysql.bidCount === beforeFaultMysql.bidCount &&
        afterRecoveryMysql.orderCount === beforeFaultMysql.orderCount
      ),
      backendConsistentAfterRecovery: backendConsistent(afterRecoveryMysql, afterRecoveryRedis),
      httpConsistentAfterRecovery: httpConsistent(afterRecoveryMysql, afterRecoveryDetail, afterRecoveryLeaderboard),
      rejoinSnapshotConsistent: rejoinClient.connected && snapshotConsistent(rejoinClient.snapshot, afterRecoveryMysql),
      recoveryBidOk: recoveryBid.ok,
      backendConsistentFinal: backendConsistent(finalMysql, finalRedis),
      httpConsistentFinal: httpConsistent(finalMysql, finalDetail, finalLeaderboard),
      wsBroadcastConsistentFinal: finalSocketBroadcast?.currentPriceCent === finalMysql.currentPriceCent &&
        finalSocketBroadcast?.leaderUserId === finalMysql.leaderUserId,
      noWrongOrder: finalMysql.orderCount === 0,
      healthAfter,
    };

    const result = {
      caseId,
      status: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL',
      generatedAt: new Date().toISOString(),
      auctionId: auction.id,
      apiWasRunning,
      mysqlContainer,
      docker: { stopOutput, startOutput },
      beforeFaultMysql,
      beforeFaultRedis,
      faultBid: {
        ok: faultBid.ok,
        status: faultBid.status,
        message: faultBid.data?.message ?? faultBid.data?.error ?? null,
      },
      redisDuringFault,
      afterRecoveryMysql,
      afterRecoveryRedis,
      afterRecoveryHttp: {
        detailStatus: afterRecoveryDetail.status,
        currentPriceCent: afterRecoveryDetail.data?.currentPriceCent ?? null,
        leaderUserId: afterRecoveryDetail.data?.leaderUserId ?? null,
        leaderboardTopAmountCent: afterRecoveryLeaderboard.data?.leaderboard?.[0]?.amountCent ?? null,
        leaderboardTopUserId: afterRecoveryLeaderboard.data?.leaderboard?.[0]?.userId ?? null,
      },
      rejoinSnapshot: rejoinClient.snapshot,
      recoveryBid: {
        ok: recoveryBid.ok,
        status: recoveryBid.status,
        message: recoveryBid.data?.message ?? recoveryBid.data?.error ?? null,
      },
      finalMysql,
      finalRedis,
      finalHttp: {
        detailStatus: finalDetail.status,
        currentPriceCent: finalDetail.data?.currentPriceCent ?? null,
        leaderUserId: finalDetail.data?.leaderUserId ?? null,
        leaderboardTopAmountCent: finalLeaderboard.data?.leaderboard?.[0]?.amountCent ?? null,
        leaderboardTopUserId: finalLeaderboard.data?.leaderboard?.[0]?.userId ?? null,
      },
      finalSocketBroadcast,
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
      `| 故障方式 | docker stop/start ${result.mysqlContainer} |`,
      `| 故障前 MySQL | ${JSON.stringify(result.beforeFaultMysql)} |`,
      `| 故障前 Redis | ${JSON.stringify(result.beforeFaultRedis)} |`,
      `| 故障期间出价 | ${JSON.stringify(result.faultBid)} |`,
      `| 故障期间 Redis | ${JSON.stringify(result.redisDuringFault)} |`,
      `| 恢复后 MySQL | ${JSON.stringify(result.afterRecoveryMysql)} |`,
      `| 恢复后 Redis | ${JSON.stringify(result.afterRecoveryRedis)} |`,
      `| 恢复后 HTTP | ${JSON.stringify(result.afterRecoveryHttp)} |`,
      `| 用户重连快照 | ${JSON.stringify(result.rejoinSnapshot)} |`,
      `| 恢复后再次出价 | ${JSON.stringify(result.recoveryBid)} |`,
      `| 最终 MySQL | ${JSON.stringify(result.finalMysql)} |`,
      `| 最终 Redis | ${JSON.stringify(result.finalRedis)} |`,
      `| 最终 HTTP | ${JSON.stringify(result.finalHttp)} |`,
      `| 最终 WebSocket 广播 | ${JSON.stringify(result.finalSocketBroadcast)} |`,
      `| 检查项 | ${JSON.stringify(result.checks)} |`,
      '',
      result.status === 'PASS'
        ? '结论：`TC-CONSIST-005` 通过。MySQL 故障恢复后，Redis / MySQL / HTTP / 用户重连快照一致，新的合法出价可以继续正确推进状态，未产生错误订单。'
        : '结论：`TC-CONSIST-005` 未通过。故障恢复后仍存在状态不一致、用户刷新异常或继续出价异常，需要暂停后续稳定性测试并优先修复。',
      '',
    ].join('\n'));

    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (mysqlStopped) {
      await docker(['start', mysqlContainer]).catch(() => {});
      await waitForMysql().catch(() => {});
    }
    for (const socket of sockets) socket.close();
    await redis.quit().catch(() => {});
    if (apiProcess) apiProcess.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
