const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const api = 'http://127.0.0.1:3000/api';
const chromePort = 9222;

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function waitForUrl(url, attempts = 50) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`URL did not become ready: ${url}`);
}

function spawnLocal(command, args) {
  return spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

class Cdp {
  constructor(webSocketDebuggerUrl) {
    this.id = 0;
    this.pending = new Map();
    this.socket = new WebSocket(webSocketDebuggerUrl);
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }

  close() {
    this.socket.close();
  }
}

async function openPage(url) {
  const response = await fetch(
    `http://127.0.0.1:${chromePort}/json/new?${encodeURIComponent(url)}`,
    { method: 'PUT' },
  );
  const target = await response.json();
  const page = new Cdp(target.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await waitFor(async () => page.evaluate('document.readyState === "complete"'));
  return page;
}

async function waitFor(check, message = 'browser condition timed out') {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await check()) return;
    await sleep(200);
  }
  throw new Error(message);
}

function setInput(index, value) {
  return `(() => {
    const input = document.querySelectorAll('input')[${index}];
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`;
}

function clickButton(text) {
  return `Array.from(document.querySelectorAll('button')).find(
    (button) => button.textContent.includes(${JSON.stringify(text)})
  ).click()`;
}

async function joinUser(page, nickname, auctionId) {
  await page.evaluate(setInput(0, nickname));
  await page.evaluate(clickButton('创建演示用户'));
  await waitFor(
    () => page.evaluate(`document.querySelector('.notice').textContent.includes('用户已创建')`),
    'demo user was not created',
  );
  await page.evaluate(setInput(1, auctionId));
  await page.evaluate(clickButton('加入直播间'));
  await waitFor(
    () => page.evaluate(`Boolean(document.querySelector('.session'))`),
    'user did not join auction',
  );
}

async function run() {
  const processes = [];
  const pages = [];
  try {
    processes.push(spawnLocal('pnpm', ['--filter', 'api-server', 'exec', 'node', 'dist/main.js']));
    processes.push(spawnLocal('pnpm', ['--filter', 'admin-web', 'dev', '--', '--host', '127.0.0.1']));
    processes.push(spawnLocal('pnpm', ['--filter', 'user-web', 'dev', '--', '--host', '127.0.0.1']));
    await Promise.all([
      waitForUrl(`${api}/health`),
      waitForUrl('http://127.0.0.1:5173'),
      waitForUrl('http://127.0.0.1:5174'),
    ]);

    const profile = `/private/tmp/auction-chrome-${randomUUID()}`;
    processes.push(spawn(chromePath, [
      '--headless=new',
      `--remote-debugging-port=${chromePort}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'ignore'] }));
    await waitForUrl(`http://127.0.0.1:${chromePort}/json/version`);

    const admin = await openPage('http://127.0.0.1:5173');
    const userA = await openPage('http://127.0.0.1:5174');
    const userB = await openPage('http://127.0.0.1:5174');
    pages.push(admin, userA, userB);

    await admin.evaluate(clickButton('登录主播身份'));
    await waitFor(
      () => admin.evaluate(`document.querySelector('.notice').textContent.includes('主播身份已登录')`),
      'admin did not log in',
    );

    await admin.evaluate(`(() => {
      const set = (name, value) => {
        const input = document.querySelector('[name="' + name + '"]');
        const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set('productName', 'E2E 演示珠宝');
      set('roomTitle', 'E2E 珠宝直播间');
      set('description', '真实浏览器端到端验证商品');
      set('capPriceYuan', '300');
      document.querySelector('.form-grid').requestSubmit();
    })()`);
    await waitFor(
      () => admin.evaluate(`document.querySelector('.notice').textContent.includes('竞拍已创建')`),
      'admin did not create auction',
    );
    const auctionId = await admin.evaluate(
      `document.querySelector('.auction-id').textContent.replace('竞拍 ID：', '').trim()`,
    );
    assert(auctionId, 'auction id is empty');
    await admin.evaluate(clickButton('开始竞拍'));
    await waitFor(
      () => admin.evaluate(`document.querySelector('.state').textContent === '竞拍中'`),
      'auction did not start',
    );

    await joinUser(userA, 'E2E 用户 A', auctionId);
    await joinUser(userB, 'E2E 用户 B', auctionId);

    await userA.evaluate(`document.querySelector('.bid').click()`);
    await waitFor(() => userB.evaluate(`document.querySelector('.price strong').textContent === '¥100.00'`));
    await userB.evaluate(`document.querySelector('.bid').click()`);
    await waitFor(() => userA.evaluate(`document.querySelector('.price strong').textContent === '¥200.00'`));
    await userA.evaluate(`document.querySelector('.bid').click()`);
    await waitFor(
      () => userA.evaluate(`document.querySelector('.winner')?.textContent.includes('你是赢家') === true`),
      'winner result was not shown',
    );
    await userA.evaluate(`document.querySelector('.pay').click()`);
    await waitFor(
      () => userA.evaluate(`document.querySelector('.order').textContent.includes('PAID')`),
      'payment result was not shown',
    );

    console.log(JSON.stringify({
      auctionId,
      adminStatus: await admin.evaluate(`document.querySelector('.state').textContent`),
      finalPrice: await userA.evaluate(`document.querySelector('.price strong').textContent`),
      winner: 'E2E 用户 A',
      paidStatus: 'PAID',
      browserFlow: 'PASSED',
    }, null, 2));
  } finally {
    pages.forEach((page) => page.close());
    processes.reverse().forEach((process) => process.kill('SIGTERM'));
  }
}

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
