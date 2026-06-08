const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { setTimeout: sleep } = require('node:timers/promises');
const { io } = require('../apps/user-web/node_modules/socket.io-client');
const Redis = require('../apps/api-server/node_modules/ioredis');

const base = 'http://127.0.0.1:3000';
const api = `${base}/api`;
const reportDir = 'reports';
mkdirSync(reportDir, { recursive: true });

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));

const caseId = args.get('case') ?? 'TC-MIX-003';
const rooms = Number(args.get('rooms') ?? 3);
const usersPerRoom = Number(args.get('users-per-room') ?? 100);

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

async function setupAuction(admin, index) {
  const stamp = Date.now();
  const product = await must('/products', {
    method: 'POST',
    headers: authHeaders(admin),
    body: { name: `2.0 多房间隔离拍品 ${index} ${stamp}`, description: `${caseId} 自动化测试拍品` },
  });
  const room = await must('/live-rooms', {
    method: 'POST',
    headers: authHeaders(admin),
    body: { title: `2.0 多房间隔离直播间 ${index} ${stamp}` },
  });
  const capPriceCent = index === 2 ? 300 : 100000;
  const auction = await must('/auctions', {
    method: 'POST',
    headers: authHeaders(admin),
    body: {
      productId: product.id,
      liveRoomId: room.id,
      startPriceCent: 0,
      incrementCent: 100,
      capPriceCent,
      durationSec: 900,
      extensionWindowSec: index === 1 ? 900 : 30,
      extensionSec: index === 1 ? 30 : 20,
    },
  });
  await must(`/auctions/${auction.id}/start`, { method: 'POST', headers: authHeaders(admin) });
  return { room, auction, capPriceCent };
}

function makeRoomMetrics(auctionId) {
  return {
    auctionId,
    connected: 0,
    snapshots: 0,
    bidAccepted: 0,
    auctionExtended: 0,
    auctionEnded: 0,
    auctionCancelled: 0,
    crossRoomEvents: 0,
    broadcastLatencies: [],
    seenForeignAuctionIds: {},
  };
}

async function connectClient(roomMetrics) {
  const socket = io(base, { transports: ['websocket'], reconnection: false, timeout: 10_000 });
  const track = (eventName, payload) => {
    const payloadAuctionId = payload?.auctionId;
    if (payloadAuctionId && payloadAuctionId !== roomMetrics.auctionId) {
      roomMetrics.crossRoomEvents += 1;
      roomMetrics.seenForeignAuctionIds[payloadAuctionId] = (roomMetrics.seenForeignAuctionIds[payloadAuctionId] ?? 0) + 1;
      return;
    }
    roomMetrics[eventName] += 1;
    if (typeof payload?.serverTime === 'number') {
      roomMetrics.broadcastLatencies.push(Math.max(0, Date.now() - payload.serverTime));
    }
  };
  socket.on('bidAccepted', (payload) => track('bidAccepted', payload));
  socket.on('auctionExtended', (payload) => track('auctionExtended', payload));
  socket.on('auctionEnded', (payload) => track('auctionEnded', payload));
  socket.on('auctionCancelled', (payload) => track('auctionCancelled', payload));

  await new Promise((resolve) => {
    socket.once('connect', resolve);
    socket.once('connect_error', resolve);
  });
  if (!socket.connected) return { socket, connected: false };

  const snapshot = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 3000);
    socket.once('auctionSnapshot', (payload) => {
      clearTimeout(timer);
      if (payload?.auctionId === roomMetrics.auctionId) roomMetrics.snapshots += 1;
      else roomMetrics.crossRoomEvents += 1;
      resolve(payload?.auctionId === roomMetrics.auctionId);
    });
    socket.emit('joinAuction', { auctionId: roomMetrics.auctionId });
  });
  if (snapshot) roomMetrics.connected += 1;
  return { socket, connected: socket.connected && snapshot };
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

async function bid(auctionId, user, amountCent) {
  return request(`/auctions/${auctionId}/bids`, {
    method: 'POST',
    headers: authHeaders(user),
    body: { requestId: randomUUID(), userId: user.id, amountCent },
  });
}

async function redisState(redis, auctionId) {
  const state = await redis.hgetall(`auction:${auctionId}:state`);
  const top = await redis.zrevrange(`auction:${auctionId}:leaderboard`, 0, 0, 'WITHSCORES');
  return {
    status: state.status ?? null,
    currentPriceCent: state.currentPriceCent ? Number(state.currentPriceCent) : null,
    leaderUserId: state.leaderUserId || null,
    leaderboardTopUserId: top[0] ?? null,
    leaderboardTopAmountCent: top[1] ? Number(top[1]) : null,
  };
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

  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', { maxRetriesPerRequest: 1 });
  const sockets = [];

  try {
    await waitForHealth();
    const admin = await login(`2.0 ${caseId} 主播`, 'ADMIN');
    const roomSetups = [];
    for (let i = 1; i <= rooms; i += 1) {
      roomSetups.push(await setupAuction(admin, i));
    }

    const metrics = roomSetups.map((item) => makeRoomMetrics(item.auction.id));
    const connectionStarted = performance.now();
    const connectedGroups = await Promise.all(metrics.map(async (roomMetrics) => Promise.all(
      Array.from({ length: usersPerRoom }, () => connectClient(roomMetrics)),
    )));
    for (const group of connectedGroups) {
      for (const client of group) sockets.push(client.socket);
    }
    const connectionDurationMs = performance.now() - connectionStarted;

    const bidders = [];
    for (let roomIndex = 1; roomIndex <= rooms; roomIndex += 1) {
      const users = [];
      for (let i = 1; i <= 3; i += 1) {
        users.push(await login(`2.0 ${caseId} 房间${roomIndex} 出价用户${i}`, 'BIDDER'));
      }
      bidders.push(users);
    }

    const bidResults = {
      room1: [
        await bid(roomSetups[0].auction.id, bidders[0][0], 100),
        await bid(roomSetups[0].auction.id, bidders[0][1], 200),
      ],
      room2: [
        await bid(roomSetups[1].auction.id, bidders[1][0], 100),
        await bid(roomSetups[1].auction.id, bidders[1][1], 200),
        await bid(roomSetups[1].auction.id, bidders[1][2], 300),
      ],
      room3: [
        await bid(roomSetups[2].auction.id, bidders[2][0], 100),
      ],
    };
    const cancelRoom3 = await request(`/auctions/${roomSetups[2].auction.id}/cancel`, {
      method: 'POST',
      headers: authHeaders(admin),
      body: { reason: 'TC-MIX-003 多房间隔离取消测试' },
    });
    await sleep(1500);

    const details = await Promise.all(roomSetups.map((item) => must(`/auctions/${item.auction.id}`)));
    const leaderboards = await Promise.all(roomSetups.map((item) => must(`/auctions/${item.auction.id}/leaderboard`)));
    const redisStates = await Promise.all(roomSetups.map((item) => redisState(redis, item.auction.id)));

    const roomSummaries = roomSetups.map((item, index) => {
      const detail = details[index];
      const leaderboardTop = leaderboards[index].leaderboard?.[0] ?? null;
      const redis = redisStates[index];
      return {
        roomIndex: index + 1,
        roomId: item.room.id,
        auctionId: item.auction.id,
        expectedFinalStatus: index === 0 ? 'RUNNING' : index === 1 ? 'SOLD' : 'CANCELLED',
        detail: {
          status: detail.status,
          currentPriceCent: detail.currentPriceCent,
          leaderUserId: detail.leaderUserId,
          orderId: detail.order?.id ?? null,
          orderAmountCent: detail.order?.amountCent ?? null,
          orderWinnerUserId: detail.order?.winnerUserId ?? null,
          cancelReason: detail.cancelReason ?? null,
        },
        leaderboardTop,
        redis,
        metrics: {
          connected: metrics[index].connected,
          snapshots: metrics[index].snapshots,
          bidAccepted: metrics[index].bidAccepted,
          auctionExtended: metrics[index].auctionExtended,
          auctionEnded: metrics[index].auctionEnded,
          auctionCancelled: metrics[index].auctionCancelled,
          crossRoomEvents: metrics[index].crossRoomEvents,
          broadcastP95Ms: Number(percentile(metrics[index].broadcastLatencies, 0.95).toFixed(2)),
          seenForeignAuctionIds: metrics[index].seenForeignAuctionIds,
        },
      };
    });

    const connectionSuccessRate = roomSummaries.reduce((sum, item) => sum + item.metrics.connected, 0) / (rooms * usersPerRoom);
    const crossRoomEventCount = roomSummaries.reduce((sum, item) => sum + item.metrics.crossRoomEvents, 0);
    const room1Ok = (
      roomSummaries[0].detail.status === 'RUNNING' &&
      roomSummaries[0].detail.currentPriceCent === 200 &&
      roomSummaries[0].metrics.auctionExtended >= usersPerRoom &&
      roomSummaries[0].detail.orderId === null
    );
    const room2Ok = (
      roomSummaries[1].detail.status === 'SOLD' &&
      roomSummaries[1].detail.currentPriceCent === 300 &&
      roomSummaries[1].detail.orderAmountCent === 300 &&
      roomSummaries[1].metrics.auctionEnded >= usersPerRoom
    );
    const room3Ok = (
      roomSummaries[2].detail.status === 'CANCELLED' &&
      roomSummaries[2].detail.currentPriceCent === 100 &&
      roomSummaries[2].detail.orderId === null &&
      roomSummaries[2].metrics.auctionCancelled >= usersPerRoom
    );
    const redisConsistent = roomSummaries.every((item) => (
      item.detail.status === item.redis.status &&
      item.detail.currentPriceCent === item.redis.currentPriceCent &&
      item.detail.leaderUserId === item.redis.leaderUserId &&
      item.leaderboardTop?.userId === item.redis.leaderboardTopUserId &&
      item.leaderboardTop?.amountCent === item.redis.leaderboardTopAmountCent
    ));
    const allBidOk = Object.values(bidResults).flat().every((item) => item.ok);
    const cancelOk = cancelRoom3.ok;
    const broadcastP95Ok = roomSummaries.every((item) => item.metrics.broadcastP95Ms <= 2000);

    const checks = {
      connectionSuccessRateOk: connectionSuccessRate >= 0.99,
      allBidOk,
      cancelOk,
      noCrossRoomEvents: crossRoomEventCount === 0,
      room1ExtensionIsolated: room1Ok,
      room2SoldIsolated: room2Ok,
      room3CancelIsolated: room3Ok,
      redisConsistent,
      broadcastP95Ok,
      healthAfter: await healthOk(),
    };

    const result = {
      caseId,
      status: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL',
      generatedAt: new Date().toISOString(),
      rooms,
      usersPerRoom,
      apiWasRunning,
      connectionDurationMs: Number(connectionDurationMs.toFixed(2)),
      connectionSuccessRate: Number(connectionSuccessRate.toFixed(4)),
      crossRoomEventCount,
      bidResults: Object.fromEntries(Object.entries(bidResults).map(([key, values]) => [
        key,
        values.map((item) => ({ ok: item.ok, status: item.status, latencyMs: Number(item.latencyMs.toFixed(2)) })),
      ])),
      cancelRoom3: { ok: cancelRoom3.ok, status: cancelRoom3.status },
      roomSummaries,
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
      `| 测试规模 | ${result.rooms} 个直播间，每房间 ${result.usersPerRoom} 用户 |`,
      `| WebSocket 连接成功率 | ${result.connectionSuccessRate} |`,
      `| 跨房间消息数 | ${result.crossRoomEventCount} |`,
      `| 出价结果 | ${JSON.stringify(result.bidResults)} |`,
      `| 房间 1 延时场 | ${JSON.stringify(result.roomSummaries[0])} |`,
      `| 房间 2 成交场 | ${JSON.stringify(result.roomSummaries[1])} |`,
      `| 房间 3 取消场 | ${JSON.stringify(result.roomSummaries[2])} |`,
      `| 检查项 | ${JSON.stringify(result.checks)} |`,
      '',
      result.status === 'PASS'
        ? '结论：`TC-MIX-003` 通过。三个直播间并行竞拍时，WebSocket 消息、排行榜、Redis 状态和订单归属未发生跨房间串扰。'
        : '结论：`TC-MIX-003` 未通过。需要根据跨房间消息、房间最终状态、Redis/HTTP 一致性或订单归属定位隔离问题。',
      '',
    ].join('\n'));

    console.log(JSON.stringify(result, null, 2));
  } finally {
    for (const socket of sockets) socket.close();
    await redis.quit().catch(() => {});
    if (apiProcess) apiProcess.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
