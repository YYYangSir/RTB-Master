const { spawn, execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { promisify } = require('node:util');
const { setTimeout: sleep } = require('node:timers/promises');
const { io } = require('../apps/user-web/node_modules/socket.io-client');
const Redis = require('../apps/api-server/node_modules/ioredis');

const execFileAsync = promisify(execFile);
const base = 'http://127.0.0.1:3000';
const api = `${base}/api`;
const reportDir = 'reports';
mkdirSync(reportDir, { recursive: true });

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));

const caseId = args.get('case') ?? 'TC-STAB-003';
const users = Number(args.get('users') ?? 500);
const settleMs = Number(args.get('settle-ms') ?? 60_000);

function authHeaders(user) {
  return { Authorization: `Bearer ${user.token}` };
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

async function shell(cmd, args) {
  try {
    const result = await execFileAsync(cmd, args, { timeout: 10_000 });
    return `${result.stdout}${result.stderr}`.trim();
  } catch (error) {
    return `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
  }
}

async function listenerPid() {
  const output = await shell('lsof', ['-nP', '-tiTCP:3000', '-sTCP:LISTEN']);
  const pid = output.split(/\s+/).find(Boolean);
  return pid ? Number(pid) : null;
}

async function establishedTcpCount() {
  const output = await shell('lsof', ['-nP', '-iTCP:3000', '-sTCP:ESTABLISHED']);
  if (!output) return 0;
  return Math.max(0, output.split('\n').filter((line) => line.trim()).length - 1);
}

async function rssKb(pid) {
  if (!pid) return null;
  const output = await shell('ps', ['-o', 'rss=', '-p', String(pid)]);
  const value = Number(output.trim());
  return Number.isFinite(value) ? value : null;
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
    body: { name: `2.0 资源回收拍品 ${stamp}`, description: `${caseId} 自动化测试拍品` },
  });
  const room = await must('/live-rooms', {
    method: 'POST',
    headers: authHeaders(admin),
    body: { title: `2.0 资源回收直播间 ${stamp}` },
  });
  const auction = await must('/auctions', {
    method: 'POST',
    headers: authHeaders(admin),
    body: {
      productId: product.id,
      liveRoomId: room.id,
      startPriceCent: 0,
      incrementCent: 100,
      capPriceCent: 100000000,
      durationSec: 900,
    },
  });
  await must(`/auctions/${auction.id}/start`, { method: 'POST', headers: authHeaders(admin) });
  return auction;
}

async function connectSocket(auctionId) {
  const socket = io(base, { transports: ['websocket'], reconnection: false, timeout: 10_000 });
  await new Promise((resolve) => {
    socket.once('connect', resolve);
    socket.once('connect_error', resolve);
  });
  if (!socket.connected) return { socket, connected: false };
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000);
    socket.once('auctionSnapshot', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.emit('joinAuction', { auctionId });
  });
  return { socket, connected: true };
}

async function redisMetrics(redis) {
  const dbSize = await redis.dbsize();
  const keyspace = await redis.info('keyspace');
  return { dbSize, keyspace: keyspace.trim() };
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
  let sockets = [];

  try {
    await waitForHealth();
    const pid = await listenerPid();
    const before = {
      listenerPid: pid,
      tcpEstablished: await establishedTcpCount(),
      rssKb: await rssKb(pid),
      redis: await redisMetrics(redis),
      health: await healthOk(),
    };

    const admin = await login(`2.0 ${caseId} 主播`, 'ADMIN');
    const auction = await setupAuction(admin);
    const connectionStarted = performance.now();
    const connected = await Promise.all(
      Array.from({ length: users }, () => connectSocket(auction.id)),
    );
    sockets = connected.map((item) => item.socket);
    const connectedCount = connected.filter((item) => item.connected).length;
    const connectionDurationMs = performance.now() - connectionStarted;

    const bidder = await login(`2.0 ${caseId} 出价用户`, 'BIDDER');
    const bid = await request(`/auctions/${auction.id}/bids`, {
      method: 'POST',
      headers: authHeaders(bidder),
      body: { requestId: randomUUID(), userId: bidder.id, amountCent: 100 },
    });
    await sleep(1000);

    const during = {
      tcpEstablished: await establishedTcpCount(),
      rssKb: await rssKb(pid),
      redis: await redisMetrics(redis),
      health: await healthOk(),
    };

    for (const socket of sockets) socket.close();
    sockets = [];
    await sleep(settleMs);

    const after = {
      tcpEstablished: await establishedTcpCount(),
      rssKb: await rssKb(pid),
      redis: await redisMetrics(redis),
      health: await healthOk(),
    };

    const connectionSuccessRate = users === 0 ? 0 : connectedCount / users;
    const rssLimit = during.rssKb ? Math.ceil(during.rssKb * 1.2) : null;
    const checks = {
      connectionSuccessRateOk: connectionSuccessRate >= 0.99,
      bidOk: bid.ok,
      tcpConnectionsReleased: after.tcpEstablished <= 5,
      memoryNotGrowingAfterDisconnect: !rssLimit || !after.rssKb || after.rssKb <= rssLimit,
      redisNotContinuingToGrow: after.redis.dbSize <= during.redis.dbSize,
      apiHealthyAfterDisconnect: after.health,
    };

    if (apiProcess) {
      apiProcess.kill('SIGTERM');
      await sleep(1500);
    }
    const residualListener = await listenerPid();
    checks.noResidualApiWhenStartedByScript = apiWasRunning ? true : residualListener === null;

    const result = {
      caseId,
      status: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL',
      generatedAt: new Date().toISOString(),
      users,
      settleMs,
      auctionId: auction.id,
      apiWasRunning,
      connectedCount,
      connectionSuccessRate: Number(connectionSuccessRate.toFixed(4)),
      connectionDurationMs: Number(connectionDurationMs.toFixed(2)),
      bid: { ok: bid.ok, status: bid.status, message: bid.data?.message ?? bid.data?.error ?? null },
      before,
      during,
      after,
      rssLimit,
      residualListener,
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
      `| WebSocket 连接 | ${result.connectedCount}/${result.users}，成功率 ${result.connectionSuccessRate} |`,
      `| 出价触发 | ${JSON.stringify(result.bid)} |`,
      `| TCP 连接数 | before=${result.before.tcpEstablished}，during=${result.during.tcpEstablished}，after=${result.after.tcpEstablished} |`,
      `| API RSS(KB) | before=${result.before.rssKb}，during=${result.during.rssKb}，after=${result.after.rssKb}，limit=${result.rssLimit} |`,
      `| Redis DBSize | before=${result.before.redis.dbSize}，during=${result.during.redis.dbSize}，after=${result.after.redis.dbSize} |`,
      `| API 健康 | before=${result.before.health}，during=${result.during.health}，after=${result.after.health} |`,
      `| 脚本启动 API 后残留监听 | ${result.apiWasRunning ? '不适用，API 原本已运行' : result.residualListener ?? '无'} |`,
      `| 检查项 | ${JSON.stringify(result.checks)} |`,
      '',
      result.status === 'PASS'
        ? '结论：`TC-STAB-003` 通过。模拟连接断开后 TCP 连接回落，Redis key 未继续增长，API 保持健康，临时启动的 API 无残留监听进程。'
        : '结论：`TC-STAB-003` 未通过。需要根据连接数、Redis key、RSS 内存或 API 健康指标定位资源回收问题。',
      '',
    ].join('\n'));

    console.log(JSON.stringify(result, null, 2));
  } finally {
    for (const socket of sockets) socket.close();
    await redis.quit().catch(() => {});
    if (apiProcess && !apiProcess.killed) apiProcess.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
