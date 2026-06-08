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

const caseId = args.get('case') ?? 'TC-CONSIST-004';
const expectedExtensions = Number(args.get('extensions') ?? 2);
const incrementCent = 100;
const capPriceCent = 100000;
const durationSec = 45;
const extensionWindowSec = 10;
const extensionSec = 20;

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
    body: { name: `2.0 延时一致性拍品 ${stamp}`, description: `${caseId} 自动化测试拍品` },
  });
  const room = await must('/live-rooms', {
    method: 'POST',
    headers: authHeaders(admin),
    body: { title: `2.0 延时一致性直播间 ${stamp}` },
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
      durationSec,
      extensionWindowSec,
      extensionSec,
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
  });
  socket.on('auctionExtended', (payload) => {
    metrics.wsSnapshot = payload;
    metrics.wsExtensionEvents.push({
      endAt: payload?.endAt ?? null,
      currentPriceCent: payload?.currentPriceCent ?? null,
      leaderUserId: payload?.leaderUserId ?? null,
    });
  });
  socket.on('auctionEnded', (payload) => {
    metrics.wsEndedEvents += 1;
    metrics.wsSnapshot = payload;
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

async function waitUntilLastWindow(auctionId) {
  for (;;) {
    const detail = await must(`/auctions/${auctionId}`);
    const remainingMs = new Date(detail.endAt).getTime() - Date.now();
    if (remainingMs <= extensionWindowSec * 1000 - 1000) return detail;
    await sleep(Math.min(1000, Math.max(100, remainingMs - extensionWindowSec * 1000 + 1000)));
  }
}

async function placeExtensionBid(auctionId, user, amountCent) {
  const before = await waitUntilLastWindow(auctionId);
  const result = await must(`/auctions/${auctionId}/bids`, {
    method: 'POST',
    headers: authHeaders(user),
    body: { requestId: randomUUID(), userId: user.id, amountCent },
  });
  const snapshot = result.snapshot ?? result.auction ?? result;
  return {
    beforeEndAt: before.endAt,
    afterEndAt: snapshot.endAt,
    beforeRemainingMs: new Date(before.endAt).getTime() - Date.now(),
    deltaMs: new Date(snapshot.endAt).getTime() - new Date(before.endAt).getTime(),
    extended: Boolean(result.extended),
    currentPriceCent: snapshot.currentPriceCent,
    leaderUserId: snapshot.leaderUserId,
  };
}

function sameTime(...values) {
  const timestamps = values.map((value) => new Date(value).getTime());
  return timestamps.every((value) => value === timestamps[0]);
}

function sameValue(...values) {
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
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', { maxRetriesPerRequest: 2 });
  const metrics = { wsSnapshot: null, wsExtensionEvents: [], wsEndedEvents: 0 };
  let observer;

  try {
    await waitForHealth();
    const admin = await login(`2.0 ${caseId} 主播`, 'ADMIN');
    const bidders = [
      await login(`2.0 ${caseId} 用户 A`, 'BIDDER'),
      await login(`2.0 ${caseId} 用户 B`, 'BIDDER'),
      await login(`2.0 ${caseId} 用户 C`, 'BIDDER'),
    ];
    const auction = await setupAuction(admin);
    observer = await connectObserver(auction.id, metrics);

    const extensionRecords = [];
    for (let i = 0; i < expectedExtensions; i += 1) {
      extensionRecords.push(await placeExtensionBid(auction.id, bidders[i % bidders.length], (i + 1) * incrementCent));
      await sleep(500);
    }

    await sleep(1000);
    const [httpDetail, httpLeaderboard, mysqlAuction, mysqlHighestBid, redisState, redisTop] = await Promise.all([
      must(`/auctions/${auction.id}`),
      must(`/auctions/${auction.id}/leaderboard`),
      prisma.auction.findUniqueOrThrow({ where: { id: auction.id } }),
      prisma.bid.findFirst({ where: { auctionId: auction.id }, orderBy: { amountCent: 'desc' } }),
      redis.hgetall(`auction:${auction.id}:state`),
      redis.zrevrange(`auction:${auction.id}:leaderboard`, 0, 0, 'WITHSCORES'),
    ]);
    const httpTop = httpLeaderboard.leaderboard?.[0] ?? null;
    const wsTop = metrics.wsSnapshot?.leaderboard?.[0] ?? null;
    const endAtConsistent = sameTime(
      mysqlAuction.endAt,
      new Date(Number(redisState.endAt)),
      httpDetail.endAt,
      metrics.wsSnapshot?.endAt,
    );
    const priceConsistent = sameValue(
      mysqlAuction.currentPriceCent,
      mysqlHighestBid?.amountCent,
      Number(redisState.currentPriceCent),
      httpDetail.currentPriceCent,
      httpTop?.amountCent,
      metrics.wsSnapshot?.currentPriceCent,
      wsTop?.amountCent,
    );
    const leaderConsistent = sameValue(
      mysqlAuction.leaderUserId,
      mysqlHighestBid?.userId,
      redisState.leaderUserId,
      httpDetail.leaderUserId,
      httpTop?.userId,
      metrics.wsSnapshot?.leaderUserId,
      wsTop?.userId,
    );
    const allExtensionsCorrect = extensionRecords.every((item) => (
      item.extended &&
      item.deltaMs === extensionSec * 1000 &&
      item.beforeRemainingMs <= extensionWindowSec * 1000
    ));
    const notEndedEarly = httpDetail.status === 'RUNNING' && metrics.wsEndedEvents === 0;

    const result = {
      caseId,
      status: (
        extensionRecords.length === expectedExtensions &&
        allExtensionsCorrect &&
        metrics.wsExtensionEvents.length === expectedExtensions &&
        endAtConsistent &&
        priceConsistent &&
        leaderConsistent &&
        notEndedEarly
      ) ? 'PASS' : 'FAIL',
      generatedAt: new Date().toISOString(),
      auctionId: auction.id,
      apiWasRunning,
      expectedExtensions,
      extensionSec,
      extensionWindowSec,
      extensionRecords,
      wsExtensionEvents: metrics.wsExtensionEvents,
      wsEndedEvents: metrics.wsEndedEvents,
      mysql: {
        endAt: mysqlAuction.endAt,
        currentPriceCent: mysqlAuction.currentPriceCent,
        leaderUserId: mysqlAuction.leaderUserId,
        status: mysqlAuction.status,
      },
      redis: {
        endAt: new Date(Number(redisState.endAt)),
        currentPriceCent: Number(redisState.currentPriceCent),
        leaderUserId: redisState.leaderUserId,
        status: redisState.status,
        leaderboardTopUserId: redisTop[0] ?? null,
        leaderboardTopAmountCent: redisTop[1] ? Number(redisTop[1]) : null,
      },
      http: {
        endAt: httpDetail.endAt,
        currentPriceCent: httpDetail.currentPriceCent,
        leaderUserId: httpDetail.leaderUserId,
        status: httpDetail.status,
        leaderboardTopUserId: httpTop?.userId ?? null,
        leaderboardTopAmountCent: httpTop?.amountCent ?? null,
      },
      websocket: {
        endAt: metrics.wsSnapshot?.endAt ?? null,
        currentPriceCent: metrics.wsSnapshot?.currentPriceCent ?? null,
        leaderUserId: metrics.wsSnapshot?.leaderUserId ?? null,
        status: metrics.wsSnapshot?.status ?? null,
        leaderboardTopUserId: wsTop?.userId ?? null,
        leaderboardTopAmountCent: wsTop?.amountCent ?? null,
      },
      checks: {
        allExtensionsCorrect,
        wsExtensionEventCountCorrect: metrics.wsExtensionEvents.length === expectedExtensions,
        endAtConsistent,
        priceConsistent,
        leaderConsistent,
        notEndedEarly,
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
      `| 延时次数 | ${result.extensionRecords.length}/${result.expectedExtensions} |`,
      `| WebSocket 延时事件 | ${result.wsExtensionEvents.length}/${result.expectedExtensions} |`,
      `| 延时记录 | ${JSON.stringify(result.extensionRecords)} |`,
      `| MySQL endAt | ${result.mysql.endAt} |`,
      `| Redis endAt | ${result.redis.endAt} |`,
      `| HTTP endAt | ${result.http.endAt} |`,
      `| WebSocket endAt | ${result.websocket.endAt} |`,
      `| 检查项 | ${JSON.stringify(result.checks)} |`,
      '',
      result.status === 'PASS'
        ? '结论：`TC-CONSIST-004` 通过，自动延时后的 endAt 在 MySQL、Redis、HTTP 和 WebSocket 中一致，且未提前结束。'
        : '结论：`TC-CONSIST-004` 未通过，需要根据检查项定位 endAt 同步或倒计时提前结束问题。',
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
