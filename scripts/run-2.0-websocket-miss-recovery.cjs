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

const caseId = args.get('case') ?? 'TC-FAULT-003';

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
    body: { name: `2.0 WS 恢复拍品 ${stamp}`, description: `${caseId} 自动化测试拍品` },
  });
  const room = await must('/live-rooms', {
    method: 'POST',
    headers: authHeaders(admin),
    body: { title: `2.0 WS 恢复直播间 ${stamp}` },
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

async function connectAndJoin(auctionId, user) {
  const socket = io(base, { transports: ['websocket'], reconnection: false, timeout: 10000 });
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
    bidCount: await prisma.bid.count({ where: { auctionId } }),
    highestBidAmountCent: highestBid?.amountCent ?? null,
    highestBidUserId: highestBid?.userId ?? null,
    orderCount: await prisma.order.count({ where: { auctionId } }),
  };
}

async function redisSnapshot(redis, auctionId) {
  const state = await redis.hgetall(`auction:${auctionId}:state`);
  const top = await redis.zrevrange(`auction:${auctionId}:leaderboard`, 0, 0, 'WITHSCORES');
  return {
    currentPriceCent: state.currentPriceCent ? Number(state.currentPriceCent) : null,
    leaderUserId: state.leaderUserId || null,
    status: state.status ?? null,
    leaderboardTopUserId: top[0] ?? null,
    leaderboardTopAmountCent: top[1] ? Number(top[1]) : null,
  };
}

function snapshotConsistent(source, expectedPrice, expectedLeader) {
  const top = source.leaderboard?.[0];
  return (
    source.currentPriceCent === expectedPrice &&
    source.leaderUserId === expectedLeader &&
    top?.amountCent === expectedPrice &&
    top?.userId === expectedLeader
  );
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
  const sockets = [];

  try {
    await waitForHealth();
    const admin = await login(`2.0 ${caseId} 主播`, 'ADMIN');
    const userA = await login(`2.0 ${caseId} 用户 A`, 'BIDDER');
    const userB = await login(`2.0 ${caseId} 用户 B`, 'BIDDER');
    const userC = await login(`2.0 ${caseId} 用户 C`, 'BIDDER');
    const auction = await setupAuction(admin);

    const clientA = await connectAndJoin(auction.id, userA);
    const clientB = await connectAndJoin(auction.id, userB);
    const clientC = await connectAndJoin(auction.id, userC);
    sockets.push(clientA.socket, clientB.socket, clientC.socket);

    clientB.socket.close();
    clientC.socket.close();
    await sleep(500);

    const bidResult = await request(`/auctions/${auction.id}/bids`, {
      method: 'POST',
      headers: authHeaders(userA),
      body: { requestId: randomUUID(), userId: userA.id, amountCent: 100 },
    });
    await sleep(500);

    const reconnectedB = await connectAndJoin(auction.id, userB);
    const reconnectedC = await connectAndJoin(auction.id, userC);
    sockets.push(reconnectedB.socket, reconnectedC.socket);

    const [mysql, redisState, httpDetail, httpLeaderboard] = await Promise.all([
      mysqlSnapshot(prisma, auction.id),
      redisSnapshot(redis, auction.id),
      must(`/auctions/${auction.id}`),
      must(`/auctions/${auction.id}/leaderboard`),
    ]);

    const http = {
      currentPriceCent: httpDetail.currentPriceCent,
      leaderUserId: httpDetail.leaderUserId,
      status: httpDetail.status,
      leaderboardTopUserId: httpLeaderboard.leaderboard?.[0]?.userId ?? null,
      leaderboardTopAmountCent: httpLeaderboard.leaderboard?.[0]?.amountCent ?? null,
    };

    const expectedPrice = 100;
    const expectedLeader = userA.id;
    const connectedUserGotBroadcast = snapshotConsistent(clientA.getBidAccepted() ?? {}, expectedPrice, expectedLeader);
    const disconnectedUsersMissedBroadcast = !clientB.getBidAccepted() && !clientC.getBidAccepted();
    const reconnectSnapshotsOk = (
      reconnectedB.connected &&
      reconnectedC.connected &&
      snapshotConsistent(reconnectedB.snapshot ?? {}, expectedPrice, expectedLeader) &&
      snapshotConsistent(reconnectedC.snapshot ?? {}, expectedPrice, expectedLeader)
    );
    const backendConsistent = (
      mysql.currentPriceCent === expectedPrice &&
      mysql.leaderUserId === expectedLeader &&
      mysql.highestBidAmountCent === expectedPrice &&
      mysql.highestBidUserId === expectedLeader &&
      mysql.bidCount === 1 &&
      mysql.orderCount === 0 &&
      redisState.currentPriceCent === expectedPrice &&
      redisState.leaderUserId === expectedLeader &&
      redisState.leaderboardTopAmountCent === expectedPrice &&
      redisState.leaderboardTopUserId === expectedLeader &&
      http.currentPriceCent === expectedPrice &&
      http.leaderUserId === expectedLeader &&
      http.leaderboardTopAmountCent === expectedPrice &&
      http.leaderboardTopUserId === expectedLeader
    );
    const healthAfter = await healthOk();

    const result = {
      caseId,
      status: (
        bidResult.ok &&
        connectedUserGotBroadcast &&
        disconnectedUsersMissedBroadcast &&
        reconnectSnapshotsOk &&
        backendConsistent &&
        healthAfter
      ) ? 'PASS' : 'FAIL',
      generatedAt: new Date().toISOString(),
      auctionId: auction.id,
      apiWasRunning,
      initialConnections: {
        userA: clientA.connected,
        userB: clientB.connected,
        userC: clientC.connected,
      },
      initialSnapshots: {
        userA: Boolean(clientA.snapshot),
        userB: Boolean(clientB.snapshot),
        userC: Boolean(clientC.snapshot),
      },
      bidResult: {
        ok: bidResult.ok,
        status: bidResult.status,
        currentPriceCent: bidResult.data?.currentPriceCent ?? bidResult.data?.snapshot?.currentPriceCent ?? null,
        leaderUserId: bidResult.data?.leaderUserId ?? bidResult.data?.snapshot?.leaderUserId ?? null,
      },
      connectedUserBroadcast: clientA.getBidAccepted(),
      disconnectedUsersMissedBroadcast,
      reconnectSnapshots: {
        userB: reconnectedB.snapshot,
        userC: reconnectedC.snapshot,
      },
      mysql,
      redis: redisState,
      http,
      checks: {
        connectedUserGotBroadcast,
        disconnectedUsersMissedBroadcast,
        reconnectSnapshotsOk,
        backendConsistent,
        noWrongOrder: mysql.orderCount === 0,
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
      `| 初始连接 | ${JSON.stringify(result.initialConnections)} |`,
      `| 出价结果 | ${JSON.stringify(result.bidResult)} |`,
      `| 已连接用户收到广播 | ${result.checks.connectedUserGotBroadcast} |`,
      `| 断线用户错过广播 | ${result.disconnectedUsersMissedBroadcast} |`,
      `| 重连快照恢复 | ${result.checks.reconnectSnapshotsOk} |`,
      `| MySQL | ${JSON.stringify(result.mysql)} |`,
      `| Redis | ${JSON.stringify(result.redis)} |`,
      `| HTTP | ${JSON.stringify(result.http)} |`,
      `| 检查项 | ${JSON.stringify(result.checks)} |`,
      '',
      result.status === 'PASS'
        ? '结论：`TC-FAULT-003` 通过，部分客户端错过 WebSocket 广播后，可通过重连 `joinAuction` 获取最新快照，后端数据保持一致。'
        : '结论：`TC-FAULT-003` 未通过，需要根据广播、重连快照或后端一致性定位问题。',
      '',
    ].join('\n'));

    console.log(JSON.stringify(result, null, 2));
  } finally {
    for (const socket of sockets) socket?.close();
    await redis.quit().catch(() => {});
    await prisma.$disconnect().catch(() => {});
    if (apiProcess) apiProcess.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
