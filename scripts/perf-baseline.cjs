const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const os = require('node:os');
const { setTimeout: sleep } = require('node:timers/promises');

const base = 'http://127.0.0.1:3000';
const api = `${base}/api`;

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function request(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

async function measuredRequest(path, { method = 'GET', body } = {}) {
  const startedAt = performance.now();
  const response = await fetch(`${api}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    status: response.status,
    latencyMs: performance.now() - startedAt,
    data: await response.json(),
  };
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await request('/health');
      return;
    } catch {
      await sleep(200);
    }
  }
  throw new Error('API did not become healthy');
}

function summarize(name, results, durationMs, consistency = {}) {
  const latencies = results.map((result) => result.latencyMs).sort((a, b) => a - b);
  const percentile = (value) => Number(latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * value))].toFixed(2));
  const statuses = {};
  for (const result of results) statuses[result.status] = (statuses[result.status] ?? 0) + 1;
  return {
    name,
    requests: results.length,
    durationMs: Number(durationMs.toFixed(2)),
    throughputRps: Number((results.length / (durationMs / 1000)).toFixed(2)),
    latencyMs: {
      p50: percentile(0.5),
      p95: percentile(0.95),
      max: Number(latencies.at(-1).toFixed(2)),
    },
    statuses,
    consistency,
  };
}

async function createAuction(productId, liveRoomId, overrides = {}) {
  const auction = await request('/auctions', {
    method: 'POST',
    body: {
      productId,
      liveRoomId,
      startPriceCent: 0,
      incrementCent: 100,
      capPriceCent: 1000000,
      durationSec: 600,
      ...overrides,
    },
  });
  await request(`/auctions/${auction.id}/start`, { method: 'POST' });
  return auction;
}

async function scenarioHotAuction(context) {
  const auction = await createAuction(context.product.id, context.room.id);
  const results = [];
  const startedAt = performance.now();
  for (let round = 1; round <= 10; round += 1) {
    const amountCent = round * 100;
    results.push(...await Promise.all(context.users.slice(0, 20).map((user) => measuredRequest(
      `/auctions/${auction.id}/bids`,
      { method: 'POST', body: { requestId: randomUUID(), userId: user.id, amountCent } },
    ))));
  }
  const durationMs = performance.now() - startedAt;
  const detail = await request(`/auctions/${auction.id}`);
  return summarize('single-hot-auction', results, durationMs, {
    expectedPriceCent: 1000,
    actualPriceCent: detail.currentPriceCent,
    exactAcceptedCount: results.filter((result) => result.status === 201).length,
    passed: detail.currentPriceCent === 1000 && results.filter((result) => result.status === 201).length === 10,
  });
}

async function scenarioParallelAuctions(context) {
  const auctions = await Promise.all(
    Array.from({ length: 10 }, () => createAuction(context.product.id, context.room.id)),
  );
  const startedAt = performance.now();
  const results = (await Promise.all(auctions.map(async (auction, auctionIndex) => {
    const auctionResults = [];
    for (let round = 0; round < 10; round += 1) {
      auctionResults.push(await measuredRequest(`/auctions/${auction.id}/bids`, {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          userId: context.users[(auctionIndex + round) % context.users.length].id,
          amountCent: (round + 1) * 100,
        },
      }));
    }
    return auctionResults;
  }))).flat();
  const durationMs = performance.now() - startedAt;
  const details = await Promise.all(auctions.map((auction) => request(`/auctions/${auction.id}`)));
  return summarize('parallel-auctions', results, durationMs, {
    auctions: auctions.length,
    expectedPriceCent: 1000,
    correctAuctions: details.filter((detail) => detail.currentPriceCent === 1000).length,
    passed: details.every((detail) => detail.currentPriceCent === 1000),
  });
}

async function scenarioDuplicateAndIllegal(context) {
  const auction = await createAuction(context.product.id, context.room.id);
  const requestId = randomUUID();
  await request(`/auctions/${auction.id}/bids`, {
    method: 'POST',
    body: { requestId, userId: context.users[0].id, amountCent: 100 },
  });
  const startedAt = performance.now();
  const results = await Promise.all([
    ...Array.from({ length: 50 }, () => measuredRequest(
      `/auctions/${auction.id}/bids`,
      { method: 'POST', body: { requestId, userId: context.users[0].id, amountCent: 100 } },
    )),
    ...Array.from({ length: 50 }, () => measuredRequest(
      `/auctions/${auction.id}/bids`,
      { method: 'POST', body: { requestId: randomUUID(), userId: context.users[1].id, amountCent: 99 } },
    )),
  ]);
  const durationMs = performance.now() - startedAt;
  const duplicateResults = results.slice(0, 50);
  const illegalResults = results.slice(50);
  return summarize('duplicate-and-illegal', results, durationMs, {
    duplicateRequests: duplicateResults.length,
    duplicateHandled: duplicateResults.filter((result) => result.status === 201 && result.data.duplicate === true).length,
    illegalRequests: illegalResults.length,
    illegalRejected: illegalResults.filter((result) => result.status === 400).length,
    passed:
      duplicateResults.every((result) => result.status === 201 && result.data.duplicate === true) &&
      illegalResults.every((result) => result.status === 400),
  });
}

async function scenarioCapRace(context) {
  const auction = await createAuction(context.product.id, context.room.id, {
    incrementCent: 10000,
    capPriceCent: 10000,
  });
  const startedAt = performance.now();
  const results = await Promise.all(context.users.map((user) => measuredRequest(
    `/auctions/${auction.id}/bids`,
    { method: 'POST', body: { requestId: randomUUID(), userId: user.id, amountCent: 10000 } },
  )));
  const durationMs = performance.now() - startedAt;
  const detail = await request(`/auctions/${auction.id}`);
  return summarize('cap-price-race', results, durationMs, {
    soldStatus: detail.status,
    orderCreated: Boolean(detail.order),
    acceptedCount: results.filter((result) => result.status === 201).length,
    passed: detail.status === 'SOLD' && Boolean(detail.order) && results.filter((result) => result.status === 201).length === 1,
  });
}

async function seed() {
  const product = await request('/products', {
    method: 'POST',
    body: { name: '压测商品', description: 'P1-E 单实例性能基线' },
  });
  const room = await request('/live-rooms', {
    method: 'POST',
    body: { title: '压测直播间' },
  });
  const users = await Promise.all(Array.from({ length: 30 }, (_, index) => request('/users', {
    method: 'POST',
    body: { nickname: `压测用户 ${index + 1}` },
  })));
  return { product, room, users };
}

async function main() {
  const apiProcess = spawn('pnpm', ['--filter', 'api-server', 'exec', 'node', 'dist/main.js'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    await waitForHealth();
    const context = await seed();
    const scenarios = [];
    scenarios.push(await scenarioHotAuction(context));
    scenarios.push(await scenarioParallelAuctions(context));
    scenarios.push(await scenarioDuplicateAndIllegal(context));
    scenarios.push(await scenarioCapRace(context));
    assert(scenarios.every((scenario) => scenario.consistency.passed), 'one or more consistency checks failed');
    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(),
      environment: {
        platform: `${os.platform()} ${os.arch()}`,
        cpuModel: os.cpus()[0]?.model,
        cpuCount: os.cpus().length,
        memoryGb: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
        node: process.version,
        apiInstances: 1,
      },
      scenarios,
    }, null, 2));
  } finally {
    apiProcess.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
