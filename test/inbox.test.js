/**
 * inbox-bridge 回归测试（node:test，对应维护域 Rev2 验收清单）。
 *
 * 本机没有独立 node，用 DSH 自带的 Electron 当 node：
 *   ELECTRON_RUN_AS_NODE=1 "D:/DSH/DeepSeek Harness.exe" test/bridge.test.js
 * 或 npm test。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { RotatingLog, apply, createBridge } from '../inbox.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORK = path.join(ROOT, '..', 'tmp', 'bridge-test');
let seq = 0;

function makeDir() {
  const dir = path.join(WORK, `${process.pid}-${seq++}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeConfig(overrides = {}) {
  const dir = makeDir();
  const configPath = path.join(dir, 'inbox-bridge.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      port: 0,
      token: 'test-token',
      sessionId: '',
      // 默认把日志/队列也放进临时目录：测试不碰 ~/.dsh，也就不会踩沙箱权限
      queueFile: path.join(dir, 'queue.jsonl'),
      logFile: path.join(dir, 'bridge.log'),
      ...overrides,
    }),
    'utf8',
  );
  return configPath;
}

function makeAgent(id, status = 'idle') {
  return {
    id,
    status,
    messages: [],
    followup(message) {
      this.messages.push(message);
    },
  };
}

async function withBridge({ agents, config = {}, journal = null } = {}) {
  const live = agents || [makeAgent('session-a')];
  const configPath = makeConfig(config);
  const queueFile = path.join(path.dirname(configPath), 'queue.jsonl');
  if (journal) fs.writeFileSync(queueFile, journal.map((line) => JSON.stringify(line)).join('\n') + '\n');
  const ctx = { agents: { list: () => live, get: (id) => live.find((agent) => agent.id === id) || null } };
  const bridge = createBridge(ctx, {
    configPath,
    queueFile,
    featuresFile: path.join(path.dirname(configPath), 'features.json'),
    logFile: null,
    silent: true,
  });
  const port = await bridge.start();
  return { bridge, port, base: `http://127.0.0.1:${port}`, agents: live, configPath, queueFile };
}

function post(base, pathName, body, token = 'test-token') {
  return fetch(base + pathName, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-inbox-token': token },
    body: JSON.stringify(body),
  });
}

function get(base, pathName, token = 'test-token') {
  return fetch(base + pathName, { headers: token === null ? {} : { 'x-inbox-token': token } });
}

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(base, attempts = 40) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(base + '/health');
      if (res.ok) return res.json();
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw lastError || new Error('health 超时');
}

// ---- 基本投递 -------------------------------------------------------------

test('默认异步：202 + queued/id/sessionId，注入立刻发生', async () => {
  const agent = makeAgent('session-a');
  const { bridge, base } = await withBridge({ agents: [agent] });
  try {
    const res = await post(base, '/inbox', { text: '你好' });
    const body = await res.json();
    assert.equal(res.status, 202);
    assert.equal(body.ok, true);
    assert.equal(body.queued, false);
    assert.equal(body.delivered, true);
    assert.equal(body.sessionId, 'session-a');
    assert.ok(body.id);
    assert.equal(agent.messages.length, 1);
    const message = agent.messages[0];
    assert.equal(message.role, 'user');
    assert.equal(message.content[0].type, 'text');
    assert.equal(message.content[0].text, '[inbox-bridge] 你好');
    assert.equal(message.source.kind, 'user');
  } finally {
    await bridge.stop();
  }
});

test('GET /delivery/{id} 能查到 delivered', async () => {
  const { bridge, base } = await withBridge({ agents: [makeAgent('session-a')] });
  try {
    const created = await (await post(base, '/inbox', { text: '查单' })).json();
    const res = await get(base, `/delivery/${created.id}`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.id, created.id);
    assert.equal(body.sessionId, 'session-a');
    assert.equal(body.status, 'delivered');
    assert.ok(body.deliveredAt > 0);
  } finally {
    await bridge.stop();
  }
});

test('GET /delivery 未知 id → 404；无 token → 401', async () => {
  const { bridge, base } = await withBridge({ agents: [makeAgent('session-a')] });
  try {
    assert.equal((await get(base, '/delivery/nope')).status, 404);
    assert.equal((await get(base, '/delivery/nope', null)).status, 401);
  } finally {
    await bridge.stop();
  }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('wait:true（空闲会话）→ 200 delivered', async () => {
  const agent = makeAgent('session-a');
  const { bridge, base } = await withBridge({ agents: [agent] });
  try {
    const res = await post(base, '/inbox', { text: '同步模式', wait: true });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.delivered, true);
    assert.equal(body.queued, false);
    assert.equal(agent.messages.length, 1);
  } finally {
    await bridge.stop();
  }
});

test('wait:true 忙且等不到 → 202 queued，不硬塞；空闲后后台补投', async () => {
  const agent = makeAgent('session-a', 'running');
  const { bridge, base } = await withBridge({ agents: [agent] });
  try {
    const res = await post(base, '/inbox', { text: '等不到空闲', wait: true, maxWaitMs: 50 });
    const body = await res.json();
    assert.equal(res.status, 202, '超时不能假装 200');
    assert.equal(body.queued, true);
    assert.equal(body.delivered, false);
    assert.equal(body.status, 'queued');
    assert.equal(agent.messages.length, 0, '没空闲就不许注入');

    const record = await (await get(base, `/delivery/${body.id}`)).json();
    assert.equal(record.status, 'queued');

    agent.status = 'idle'; // 会话跑完了
    await sleep(1200); // 后台泵 500ms 一轮
    assert.equal(agent.messages.length, 1, '空闲后应自动补投');
    const after = await (await get(base, `/delivery/${body.id}`)).json();
    assert.equal(after.status, 'delivered');
  } finally {
    await bridge.stop();
  }
});

test('onBusy=wait：等到空闲才投，空闲前一条都不注入', async () => {
  const agent = makeAgent('session-a', 'running');
  let releaseIdle;
  agent.whenIdle = () => new Promise((resolve) => { releaseIdle = resolve; });
  const { bridge, base } = await withBridge({ agents: [agent] });
  try {
    const pending = post(base, '/inbox', { text: '等我空闲', onBusy: 'wait', maxWaitMs: 5000 });
    await sleep(80);
    assert.equal(agent.messages.length, 0, '还是忙的，不能注入');
    agent.status = 'idle';
    releaseIdle();
    const res = await pending;
    const body = await res.json();
    assert.equal(res.status, 202);
    assert.equal(body.delivered, true);
    assert.equal(agent.messages.length, 1);
  } finally {
    await bridge.stop();
  }
});

test('会话忙碌时不阻塞请求（旧版会挂 90 秒）', async () => {
  const agent = makeAgent('session-a', 'running');
  const { bridge, base } = await withBridge({ agents: [agent] });
  try {
    const started = Date.now();
    const res = await post(base, '/inbox', { text: '忙时也要立刻收' });
    assert.equal(res.status, 202);
    assert.ok(Date.now() - started < 2000, `不该阻塞，实际 ${Date.now() - started}ms`);
    assert.equal(agent.messages.length, 1, '默认 queue：DSH 自己排到下一轮');
  } finally {
    await bridge.stop();
  }
});

test('onBusy=drop：忙时立即丢弃并明确告知', async () => {
  const agent = makeAgent('session-a', 'running');
  const { bridge, base } = await withBridge({ agents: [agent] });
  try {
    const res = await post(base, '/inbox', { text: '别等了', onBusy: 'drop' });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.dropped, true);
    assert.equal(body.reason, 'busy');
    assert.equal(agent.messages.length, 0);
  } finally {
    await bridge.stop();
  }
});

test('dedupeKey：同 key 只投一次，回 duplicate + 原 id', async () => {
  const agent = makeAgent('session-a');
  const { bridge, base } = await withBridge({ agents: [agent] });
  try {
    const first = await (await post(base, '/inbox', { text: '回执', dedupeKey: 'k1' })).json();
    const second = await (await post(base, '/inbox', { text: '回执', dedupeKey: 'k1' })).json();
    assert.equal(first.duplicate, undefined);
    assert.equal(second.duplicate, true);
    assert.equal(second.id, first.id);
    assert.equal(agent.messages.length, 1);
  } finally {
    await bridge.stop();
  }
});

test('dedupeKey 按会话隔离，不同 key 各投一次', async () => {
  const a = makeAgent('session-a');
  const b = makeAgent('session-b');
  const { bridge, base } = await withBridge({ agents: [a, b], config: { sessionId: 'session-a' } });
  try {
    await post(base, '/inbox', { text: '同一段', dedupeKey: 'k1' });
    await post(base, '/inbox', { text: '同一段', dedupeKey: 'k1', sessionId: 'session-b' });
    await post(base, '/inbox', { text: '另一段', dedupeKey: 'k2' });
    assert.equal(a.messages.length, 2);
    assert.equal(b.messages.length, 1);
  } finally {
    await bridge.stop();
  }
});

test('没有 dedupeKey 时同样内容照常再投（不猜重复）', async () => {
  const agent = makeAgent('session-a');
  const { bridge, base } = await withBridge({ agents: [agent] });
  try {
    await post(base, '/inbox', { text: '重复的话' });
    await post(base, '/inbox', { text: '重复的话' });
    assert.equal(agent.messages.length, 2);
  } finally {
    await bridge.stop();
  }
});

test('投递失败不占用 dedupeKey，重试还能投', async () => {
  const agent = makeAgent('session-a');
  const { bridge, base } = await withBridge({ agents: [agent] });
  const original = agent.followup;
  agent.followup = () => {
    throw new Error('agent disposed');
  };
  try {
    const res = await post(base, '/inbox', { text: '会失败', dedupeKey: 'retry-1' });
    assert.equal(res.status, 500);
    agent.followup = original;
    const retry = await post(base, '/inbox', { text: '会失败', dedupeKey: 'retry-1' });
    assert.equal(retry.status, 202);
    assert.equal(agent.messages.length, 1);
  } finally {
    await bridge.stop();
  }
});

// ---- 会话选择 -----------------------------------------------------------

test('GET /sessions 带 token 返回 id/name/live/busy/lastActiveAt', async () => {
  const a = makeAgent('session-a', 'running');
  const b = makeAgent('session-b');
  const { bridge, base } = await withBridge({ agents: [a, b] });
  try {
    const res = await get(base, '/sessions');
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.sessions.map((item) => item.id).sort(), ['session-a', 'session-b']);
    const first = body.sessions.find((item) => item.id === 'session-a');
    assert.equal(first.busy, true);
    assert.equal(first.live, true);
    assert.equal(typeof first.name, 'string');
    assert.equal(typeof first.lastActiveAt, 'number');
  } finally {
    await bridge.stop();
  }
});

test('GET /sessions 无 token → 401', async () => {
  const { bridge, base } = await withBridge({ agents: [makeAgent('session-a')] });
  try {
    assert.equal((await get(base, '/sessions', null)).status, 401);
    assert.equal((await get(base, '/sessions', 'wrong')).status, 401);
  } finally {
    await bridge.stop();
  }
});

test('单会话不指定 sessionId 也能投；多会话 409；未知 404', async () => {
  const solo = await withBridge({ agents: [makeAgent('session-only')] });
  try {
    const body = await (await post(solo.base, '/inbox', { text: '唯一会话' })).json();
    assert.equal(body.sessionId, 'session-only');
  } finally {
    await solo.bridge.stop();
  }

  const multi = await withBridge({ agents: [makeAgent('session-a'), makeAgent('session-b')] });
  try {
    assert.equal((await post(multi.base, '/inbox', { text: '给谁' })).status, 409);
    assert.equal((await post(multi.base, '/inbox', { text: 'x', sessionId: 'nope' })).status, 404);
  } finally {
    await multi.bridge.stop();
  }
});

// ---- 边界与错误码 -------------------------------------------------------

test('401：错 token 不注入', async () => {
  const agent = makeAgent('session-a');
  const { bridge, base } = await withBridge({ agents: [agent] });
  try {
    assert.equal((await post(base, '/inbox', { text: 'x' }, 'wrong')).status, 401);
    assert.equal(agent.messages.length, 0);
  } finally {
    await bridge.stop();
  }
});

test('400：空正文 / 坏 JSON', async () => {
  const agent = makeAgent('session-a');
  const { bridge, base } = await withBridge({ agents: [agent] });
  try {
    assert.equal((await post(base, '/inbox', { text: '   ' })).status, 400);
    const bad = await fetch(base + '/inbox', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-inbox-token': 'test-token' },
      body: '{not json',
    });
    assert.equal(bad.status, 400);
    assert.equal(agent.messages.length, 0);
  } finally {
    await bridge.stop();
  }
});

test('413 按 UTF-8 字节算：1 万中文能过，7.5 万字节被拒', async () => {
  const agent = makeAgent('session-a');
  const { bridge, base } = await withBridge({ agents: [agent] });
  try {
    const tenThousand = '中'.repeat(10_000); // 30000 字节 < 64 KiB
    assert.equal((await post(base, '/inbox', { text: tenThousand })).status, 202);
    assert.equal(agent.messages.length, 1);
    // 25000 个中文 = 75000 字节 > 64 KiB（若按 UTF-16 长度只有 25000，会被误放行）
    assert.equal((await post(base, '/inbox', { text: '中'.repeat(25_000) })).status, 413);
    assert.equal(agent.messages.length, 1);
  } finally {
    await bridge.stop();
  }
});

test('followup 抛错：500 且 /delivery 记 failed', async () => {
  const agent = makeAgent('session-a');
  agent.followup = () => {
    throw new Error('agent disposed');
  };
  const { bridge, base } = await withBridge({ agents: [agent] });
  try {
    const res = await post(base, '/inbox', { text: 'x' });
    const body = await res.json();
    assert.equal(res.status, 500);
    assert.match(body.error, /agent disposed/);
    const record = await (await get(base, `/delivery/${body.id}`)).json();
    assert.equal(record.status, 'failed');
  } finally {
    await bridge.stop();
  }
});

test('429：持久队列积压到上限后拒绝新消息', async () => {
  const journal = Array.from({ length: 1000 }, (_, i) => ({
    id: `job-${i}`,
    at: Date.now(),
    sessionId: 'session-gone',
    text: '积压',
    verdict: 'accepted',
  }));
  const { bridge, base } = await withBridge({ agents: [makeAgent('session-a')], journal });
  try {
    const res = await post(base, '/inbox', { text: '再来一条' });
    assert.equal(res.status, 429);
    const health = await (await fetch(base + '/health')).json();
    assert.equal(health.queued, 1000);
  } finally {
    await bridge.stop();
  }
});

// ---- 前缀与可观测性 -----------------------------------------------------

test('source 渲染成 [inbox-bridge:<source>]，默认不变', async () => {
  const agent = makeAgent('session-a');
  const { bridge, base } = await withBridge({ agents: [agent] });
  try {
    await post(base, '/inbox', { text: '告警', source: '鱼守护' });
    await post(base, '/inbox', { text: '普通' });
    assert.equal(agent.messages[0].content[0].text, '[inbox-bridge:鱼守护] 告警');
    assert.equal(agent.messages[1].content[0].text, '[inbox-bridge] 普通');
  } finally {
    await bridge.stop();
  }
});

test('/health 返回 version/queued/delivered/failed/lastDeliveredAt/uptimeSec', async () => {
  const { bridge, base } = await withBridge({ agents: [makeAgent('session-a')] });
  try {
    await post(base, '/inbox', { text: '一' });
    await post(base, '/inbox', { text: '二' });
    const body = await (await fetch(base + '/health')).json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.version, 'string');
    assert.equal(body.delivered, 2);
    assert.equal(body.failed, 0);
    assert.equal(body.queued, 0);
    assert.ok(body.lastDeliveredAt > 0);
    assert.equal(typeof body.uptimeSec, 'number');
    assert.equal(body.config.ok, true, '正常配置不该报损坏');
    assert.equal(body.sessions, 1);
    assert.equal(JSON.stringify(body).includes('session-a'), false);
  } finally {
    await bridge.stop();
  }
});

test('日志行带 ISO 时间戳，超限轮转出 .1', () => {
  const dir = makeDir();
  const file = path.join(dir, 'bridge.log');
  const log = new RotatingLog(file, { maxBytes: 300, silent: true });
  for (let i = 0; i < 20; i++) log.write(`第 ${i} 行测试，占点字节`);
  assert.ok(fs.existsSync(`${file}.1`), '应轮转出 .1');
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /);
});

// ---- 持久队列与补投 -----------------------------------------------------

test('重启补投：journal 里没终态的条目录入后投递并清理', async () => {
  const agent = makeAgent('session-a');
  const journal = [
    { id: 'pending-1', at: Date.now() - 60_000, sessionId: 'session-a', text: '重启前没投出去', verdict: 'accepted' },
    { id: 'done-1', at: Date.now() - 90_000, sessionId: 'session-a', text: '早就投过', verdict: 'delivered' },
  ];
  const { bridge, base, queueFile } = await withBridge({ agents: [agent], journal });
  try {
    assert.equal(agent.messages.length, 1, '只补投没终态的那条');
    assert.equal(agent.messages[0].content[0].text, '[inbox-bridge] 重启前没投出去');
    const record = await (await get(base, '/delivery/pending-1')).json();
    assert.equal(record.status, 'delivered');
    const left = fs.readFileSync(queueFile, 'utf8').trim();
    assert.equal(left, '', '补投完应把已完成条目清掉');
  } finally {
    await bridge.stop();
  }
});

test('补投时目标会话不活着 → 留在 journal，health.queued 计数', async () => {
  const journal = [
    { id: 'pending-2', at: Date.now(), sessionId: 'session-gone', text: '等会话回来', verdict: 'accepted' },
  ];
  const { bridge, base, queueFile } = await withBridge({ agents: [makeAgent('session-a')], journal });
  try {
    const health = await (await fetch(base + '/health')).json();
    assert.equal(health.queued, 1);
    assert.match(fs.readFileSync(queueFile, 'utf8'), /pending-2/);
  } finally {
    await bridge.stop();
  }
});

// ---- 配置、关闭与并发 ---------------------------------------------------

test('/config 改默认会话；端口越界不写入', async () => {
  const a = makeAgent('session-a');
  const b = makeAgent('session-b');
  const { bridge, base, configPath } = await withBridge({ agents: [a, b] });
  try {
    const body = await (await post(base, '/config', { sessionId: 'session-b', port: 99999 })).json();
    assert.equal(body.sessionId, 'session-b');
    assert.equal(body.port, 0, '越界端口应被忽略');
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(saved.sessionId, 'session-b');
    await post(base, '/inbox', { text: '按新默认投' });
    assert.equal(b.messages.length, 1);
    assert.equal(a.messages.length, 0);
  } finally {
    await bridge.stop();
  }
});

test('stop 后端口释放、请求失败', async () => {
  const { bridge, base } = await withBridge({ agents: [makeAgent('session-a')] });
  await bridge.stop();
  await assert.rejects(() => fetch(base + '/health'));
});

test('并发 8 条都收到；顺序 4 条不乱', async () => {
  const agent = makeAgent('session-a');
  const { bridge, base } = await withBridge({ agents: [agent] });
  try {
    const texts = Array.from({ length: 8 }, (_, i) => `并发${i}`);
    const results = await Promise.all(texts.map((text) => post(base, '/inbox', { text })));
    assert.deepEqual(results.map((r) => r.status), texts.map(() => 202));
    const got = agent.messages.map((m) => m.content[0].text).sort();
    assert.deepEqual(got, texts.map((t) => '[inbox-bridge] ' + t).sort());

    const ordered = ['一', '二', '三', '四'];
    for (const text of ordered) assert.equal((await post(base, '/inbox', { text })).status, 202);
    const tail = agent.messages.slice(-4).map((m) => m.content[0].text);
    assert.deepEqual(tail, ordered.map((t) => '[inbox-bridge] ' + t));
  } finally {
    await bridge.stop();
  }
});

test('apply 起服务并注册 effect；disposer 后端口释放', async () => {
  const port = await freePort();
  const configPath = makeConfig();
  const previousConfig = process.env.INBOX_BRIDGE_CONFIG;
  const previousPort = process.env.INBOX_BRIDGE_PORT;
  process.env.INBOX_BRIDGE_CONFIG = configPath;
  process.env.INBOX_BRIDGE_PORT = String(port);
  const agent = makeAgent('session-a');
  const disposers = [];
  const ctx = {
    agents: { list: () => [agent], get: (id) => (id === 'session-a' ? agent : null) },
    effect: (register) => {
      const disposer = register();
      disposers.push(disposer);
      return disposer;
    },
  };
  try {
    apply(ctx);
    const health = await waitForHealth(`http://127.0.0.1:${port}`);
    assert.equal(health.ok, true);
    assert.equal(health.sessions, 1);
    assert.equal(disposers.length, 1);
    await disposers[0]();
    await assert.rejects(() => fetch(`http://127.0.0.1:${port}/health`));
  } finally {
    if (previousConfig === undefined) delete process.env.INBOX_BRIDGE_CONFIG;
    else process.env.INBOX_BRIDGE_CONFIG = previousConfig;
    if (previousPort === undefined) delete process.env.INBOX_BRIDGE_PORT;
    else process.env.INBOX_BRIDGE_PORT = previousPort;
  }
});

test('端口被占时 start 报错、不留半死 server，stop 仍安全', async () => {
  const port = await freePort();
  const first = await withBridge({ agents: [makeAgent('session-a')], config: { port } });
  try {
    const configPath = makeConfig({ port });
    const second = createBridge(
      { agents: { list: () => [], get: () => null } },
      {
        configPath,
        queueFile: path.join(path.dirname(configPath), 'queue.jsonl'),
        logFile: null,
        silent: true,
      },
    );
    await assert.rejects(() => second.start(), /EADDRINUSE/);
    assert.equal(second.server, null);
    await second.stop();
  } finally {
    await first.bridge.stop();
  }
});

// ---- 配置健壮性（O10-2）--------------------------------------------------

test('配置损坏：留档 .corrupt-<ts>、原子重建、/health 报出来', async () => {
  const dir = makeDir();
  const configPath = path.join(dir, 'inbox-bridge.json');
  const original = '{ "port": 39881, "token": "old-token" '; // 截断的 JSON
  fs.writeFileSync(configPath, original, 'utf8');
  const agent = makeAgent('session-a');
  const ctx = { agents: { list: () => [agent], get: (id) => (id === 'session-a' ? agent : null) } };
  const bridge = createBridge(ctx, {
    configPath,
    queueFile: path.join(dir, 'queue.jsonl'),
    logFile: path.join(dir, 'bridge.log'),
    silent: true,
  });
  // 配置坏了就退回默认端口（39881 可能被真实实例占着），测试用环境变量指定一个空闲端口
  const previousPort = process.env.INBOX_BRIDGE_PORT;
  const port = await freePort();
  process.env.INBOX_BRIDGE_PORT = String(port);
  try {
    await bridge.start();
    const base = `http://127.0.0.1:${port}`;
    const health = await (await fetch(base + '/health')).json();
    assert.equal(health.config.ok, false, '重建过就要报出来');
    assert.ok(health.config.backup, '应给出留档路径');
    assert.equal(fs.readFileSync(health.config.backup, 'utf8'), original, '留档内容要原样');
    const rebuilt = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.ok(rebuilt.token && rebuilt.token.length >= 32, '应重建出 token');
    assert.notEqual(rebuilt.token, 'old-token');
    assert.equal((await get(base, '/sessions', 'old-token')).status, 401);
    assert.equal((await get(base, '/sessions', rebuilt.token)).status, 200, '新 token 应可用');
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.includes('.tmp-')),
      [],
      '原子写不该留临时文件',
    );
  } finally {
    await bridge.stop();
    if (previousPort === undefined) delete process.env.INBOX_BRIDGE_PORT;
    else process.env.INBOX_BRIDGE_PORT = previousPort;
  }
});

test('/config 写入不留临时文件，且读到的是完整 JSON', async () => {
  const { bridge, base, configPath } = await withBridge({ agents: [makeAgent('session-a')] });
  try {
    await post(base, '/config', { sessionId: 'session-a' });
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(saved.sessionId, 'session-a');
    assert.equal(saved.token, 'test-token');
    assert.deepEqual(
      fs.readdirSync(path.dirname(configPath)).filter((name) => name.includes('.tmp-')),
      [],
    );
  } finally {
    await bridge.stop();
  }
});

// ---- 按会话的功能开关（B） ----------------------------------------------

test('/features：默认为关，POST 打开/关闭并可回读', async () => {
  const { bridge, base } = await withBridge({ agents: [makeAgent('session-a')] });
  try {
    const initial = await (await fetch(base + '/features/model-tools?sessionId=session-a')).json();
    assert.deepEqual(initial, { ok: true, sessionId: 'session-a', enabled: false });

    const on = await (await fetch(base + '/features/model-tools', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-a', enabled: true }),
    })).json();
    assert.deepEqual(on, { ok: true, sessionId: 'session-a', enabled: true });

    const again = await (await fetch(base + '/features/model-tools?sessionId=session-a')).json();
    assert.equal(again.enabled, true);

    const health = await (await fetch(base + '/health')).json();
    assert.equal(health.features, 1);

    const off = await (await fetch(base + '/features/model-tools', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-a', enabled: false }),
    })).json();
    assert.equal(off.enabled, false);
  } finally {
    await bridge.stop();
  }
});

test('/features：缺 sessionId 400；回环 Origin 才反射，外部 Origin/Host 拒绝', async () => {
  const { bridge, base } = await withBridge({ agents: [makeAgent('session-a')] });
  try {
    const bad = await fetch(base + '/features/model-tools');
    assert.equal(bad.status, 400);
    assert.equal(bad.headers.get('access-control-allow-origin'), null, '无 Origin 不返回 CORS 头');

    // 回环页面：反射 Origin
    const ok = await fetch(base + '/features/model-tools', { headers: { origin: 'http://127.0.0.1:5555' } });
    assert.equal(ok.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5555');

    const preflight = await fetch(base + '/features/model-tools', {
      method: 'OPTIONS',
      headers: { origin: 'http://127.0.0.1:5555' },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5555');
    assert.match(preflight.headers.get('access-control-allow-methods') || '', /POST/);

    // 远程网页：拒绝（S1）
    const foreign = await fetch(base + '/features/model-tools', { headers: { origin: 'https://evil.example' } });
    assert.equal(foreign.status, 403);

    // 非回环 Host（DNS rebinding）：拒绝。fetch 会自己写 Host，这里用原始 http 请求模拟
    const rebindStatus = await new Promise((resolve, reject) => {
      const u = new URL(base + '/health');
      const req = http.request(
        { hostname: u.hostname, port: u.port, path: '/health', headers: { host: 'evil.example' } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(rebindStatus, 403);
  } finally {
    await bridge.stop();
  }
});
