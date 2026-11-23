/**
 * session-model 单测：四个工具的查/改/校验/跨会话消息/边界。
 *
 * 跑法（本机没有独立 node，用 DSH 自带 Electron）：
 *   ELECTRON_RUN_AS_NODE=1 "D:/DSH/DeepSeek Harness.exe" test/session-model.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply, createTools } from '../model.js';

// 按会话开关的状态文件：默认给测试里的调用方开着
const FEATURES = path.join(os.tmpdir(), `session-bridge-features-${process.pid}-${Date.now()}.json`);
process.env.SESSION_BRIDGE_FEATURES = FEATURES;
const ENABLED = ['session-caller', 'session-a'];
function setEnabled(ids) {
  fs.writeFileSync(FEATURES, JSON.stringify({ enabled: ids }), 'utf8');
}
setEnabled(ENABLED);

function makeAgent(id, selection, opts = {}) {
  let current = selection;
  const messages = [];
  const header = opts.lastUsed ? { config: opts.lastUsed } : undefined;
  return {
    id,
    status: opts.status || 'idle',
    messages,
    session: { requestHeader: () => header },
    model: {
      current: () => current,
      select(next) {
        current = { ...next };
      },
    },
    followup(message) {
      messages.push(message);
    },
  };
}

function makeCtx(agents, overrides = {}) {
  return {
    agents: {
      list: () => agents,
      get: (id) => agents.find((agent) => agent.id === id),
      currentInitiator: () => overrides.caller || { id: 'session-caller' },
    },
    llm: {
      listProviders: () => [
        { id: 'deepseek-account', name: 'DeepSeek' },
        { id: 'bailian-tpp', name: 'Bailian' },
        { id: 'empty-one', name: 'Empty' },
      ],
      listModels: async (provider) => {
        if (provider === 'deepseek-account') return [{ id: 'deepseek-flash', name: 'Flash' }];
        if (provider === 'bailian-tpp') return [{ id: 'qwen4-max', name: 'Qwen Max' }];
        return [];
      },
      resolveModelInfo: async (provider, model) => {
        if (provider === 'bailian-tpp' && model === 'boom') throw new Error('info failed');
        return {
          provider,
          id: model,
          name: model,
          context: { contextWindow: 128000 },
          reasoning: { efforts: [{ id: 'high' }, { id: 'medium' }], defaultEffort: 'medium' },
          inputModalities: ['text', 'image'],
        };
      },
      resolveCallConfig: async (selection) => {
        const known =
          (selection.provider === 'deepseek-account' && selection.model === 'deepseek-flash') ||
          (selection.provider === 'bailian-tpp' && selection.model === 'qwen4-max');
        if (!known) throw new Error(`unknown model ${selection.provider}/${selection.model}`);
        if (selection.reasoningEffort !== undefined && selection.reasoningEffort !== 'high') {
          throw new Error(`unknown reasoning effort ${selection.reasoningEffort}`);
        }
        return selection;
      },
      ...overrides.llm,
    },
  };
}

// ---- list ---------------------------------------------------------------

test('list：当前模型 + 上一次实际使用的模型', async () => {
  const ctx = makeCtx([
    makeAgent('session-a', { provider: 'deepseek-account', model: 'deepseek-flash' }, {
      status: 'running',
      lastUsed: { provider: 'deepseek-account', model: 'deepseek-flash' },
    }),
    makeAgent('session-b', null),
  ]);
  const value = await createTools(ctx).list.execute({});
  assert.equal(value.sessions.length, 2);
  assert.deepEqual(value.sessions[0], {
    id: 'session-a',
    busy: true,
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    reasoningEffort: null,
    pending: false,
    lastUsed: { provider: 'deepseek-account', model: 'deepseek-flash' },
  });
  assert.equal(value.sessions[1].provider, null);
  assert.equal(value.sessions[1].pending, false);
});

test('list：已选新模型但还没请求过 → pending=true', async () => {
  const ctx = makeCtx([
    makeAgent('session-a', { provider: 'bailian-tpp', model: 'qwen4-max' }, {
      lastUsed: { provider: 'deepseek-account', model: 'deepseek-flash' },
    }),
  ]);
  const value = await createTools(ctx).list.execute({});
  assert.equal(value.sessions[0].pending, true);
  assert.equal(value.sessions[0].lastUsed.model, 'deepseek-flash');
});

// ---- catalog ------------------------------------------------------------

test('catalog：返回上下文窗口、推理强度、输入模态', async () => {
  const value = await createTools(makeCtx([])).catalog.execute({});
  assert.equal(value.providers.length, 3);
  const bailian = value.providers.find((provider) => provider.id === 'bailian-tpp');
  assert.equal(bailian.models[0].id, 'qwen4-max');
  assert.equal(bailian.models[0].contextWindow, 128000);
  assert.deepEqual(bailian.models[0].reasoningEfforts, ['high', 'medium']);
  assert.equal(bailian.models[0].defaultEffort, 'medium');
  assert.deepEqual(bailian.models[0].inputModalities, ['text', 'image']);
  const empty = value.providers.find((provider) => provider.id === 'empty-one');
  assert.deepEqual(empty.models, []);
});

test('catalog：provider 过滤；未知 provider 报错并列出已知', async () => {
  const tools = createTools(makeCtx([]));
  const value = await tools.catalog.execute({ provider: 'bailian-tpp' });
  assert.equal(value.providers.length, 1);
  await assert.rejects(
    () => tools.catalog.execute({ provider: 'nope' }),
    /没有这个 provider：nope（已知：deepseek-account, bailian-tpp, empty-one）/,
  );
});

test('catalog：provider 列表或模型元数据失败要标出来，不影响其它', async () => {
  const ctx = makeCtx([], {
    llm: {
      listProviders: () => [
        { id: 'deepseek-account', name: 'DeepSeek' },
        { id: 'bad', name: 'Bad' },
      ],
      listModels: async (provider) => {
        if (provider === 'bad') throw new Error('list failed');
        return [{ id: 'deepseek-flash', name: 'Flash' }];
      },
      resolveModelInfo: async () => {
        throw new Error('info failed');
      },
    },
  });
  const value = await createTools(ctx).catalog.execute({});
  const ok = value.providers.find((provider) => provider.id === 'deepseek-account');
  assert.match(ok.models[0].error, /info failed/);
  const bad = value.providers.find((provider) => provider.id === 'bad');
  assert.match(bad.error, /list failed/);
});

// ---- set ----------------------------------------------------------------

test('set：换模型并返回前后值，下一轮生效', async () => {
  const target = makeAgent('session-b', { provider: 'deepseek-account', model: 'deepseek-flash' }, {
    lastUsed: { provider: 'deepseek-account', model: 'deepseek-flash' },
  });
  const tools = createTools(makeCtx([makeAgent('session-a', null), target]));
  const value = await tools.set.execute({ sessionId: 'session-b', provider: 'bailian-tpp', model: 'qwen4-max' });
  assert.equal(value.ok, true);
  assert.deepEqual(value.previous, { provider: 'deepseek-account', model: 'deepseek-flash' });
  assert.deepEqual(value.selected, { provider: 'bailian-tpp', model: 'qwen4-max' });
  assert.equal(value.appliedAt, 'next-step');
  assert.deepEqual(target.model.current(), { provider: 'bailian-tpp', model: 'qwen4-max' });
});

test('set：reasoningEffort 透传并由 llm 校验', async () => {
  const target = makeAgent('session-b', null);
  const value = await createTools(makeCtx([target])).set.execute({
    sessionId: 'session-b',
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    reasoningEffort: 'high',
  });
  assert.equal(value.selected.reasoningEffort, 'high');
});

test('set：未知会话报错并列出活会话', async () => {
  await assert.rejects(
    () => createTools(makeCtx([makeAgent('session-a', null)])).set.execute({
      sessionId: 'session-nope',
      provider: 'deepseek-account',
      model: 'deepseek-flash',
    }),
    /没有这个活会话：session-nope（活会话：session-a）/,
  );
});

test('set：模型不可用时报错且不改动', async () => {
  const target = makeAgent('session-b', { provider: 'deepseek-account', model: 'deepseek-flash' });
  await assert.rejects(
    () => createTools(makeCtx([target])).set.execute({
      sessionId: 'session-b',
      provider: 'bailian-tpp',
      model: 'not-exist',
    }),
    /模型不可用：bailian-tpp\/not-exist/,
  );
  assert.deepEqual(target.model.current(), { provider: 'deepseek-account', model: 'deepseek-flash' });
});

test('set：缺参数直接报错', async () => {
  await assert.rejects(
    () => createTools(makeCtx([makeAgent('session-a', null)])).set.execute({ sessionId: 'session-a' }),
    /都是必填/,
  );
});

test('set：跨会话默认通知对方；caller 是自己或 notify:false 时不通知', async () => {
  // 跨会话：默认通知
  const target = makeAgent('session-b', { provider: 'deepseek-account', model: 'deepseek-flash' });
  const ctx = makeCtx([makeAgent('session-a', null), target], { caller: { id: 'session-a' } });
  const value = await createTools(ctx).set.execute({ sessionId: 'session-b', provider: 'bailian-tpp', model: 'qwen4-max' });
  assert.equal(value.notified, true);
  assert.equal(target.messages.length, 1);
  assert.match(target.messages[0].content[0].text, /^\[session-bridge:model\] session-a 已把你的模型从 deepseek-account\/deepseek-flash 切到 bailian-tpp\/qwen4-max/);
  assert.equal(target.messages[0].role, 'user');

  // 自己改自己：不通知
  const self = makeAgent('session-a', { provider: 'deepseek-account', model: 'deepseek-flash' });
  const selfCtx = makeCtx([self], { caller: { id: 'session-a' } });
  const selfValue = await createTools(selfCtx).set.execute({ sessionId: 'session-a', provider: 'bailian-tpp', model: 'qwen4-max' });
  assert.equal(selfValue.notified, false);
  assert.equal(self.messages.length, 0);

  // 显式 notify:false
  const quiet = makeAgent('session-b', { provider: 'deepseek-account', model: 'deepseek-flash' });
  const quietCtx = makeCtx([makeAgent('session-a', null), quiet], { caller: { id: 'session-a' } });
  const quietValue = await createTools(quietCtx).set.execute({
    sessionId: 'session-b',
    provider: 'bailian-tpp',
    model: 'qwen4-max',
    notify: false,
  });
  assert.equal(quietValue.notified, false);
  assert.equal(quiet.messages.length, 0);
});

test('set：note 会附进通知里', async () => {
  const target = makeAgent('session-b', null);
  const ctx = makeCtx([makeAgent('session-a', null), target], { caller: { id: 'session-a' } });
  await createTools(ctx).set.execute({
    sessionId: 'session-b',
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    note: '预算紧张，先用便宜的',
  });
  assert.match(target.messages[0].content[0].text, /预算紧张，先用便宜的$/);
});

// ---- message ------------------------------------------------------------

test('message：投进目标会话，带前缀与 source，忙时标 queued', async () => {
  const target = makeAgent('session-b', null, { status: 'running' });
  const tools = createTools(makeCtx([target]));
  const value = await tools.message.execute({ sessionId: 'session-b', text: '换到 qwen4-max 吧', source: '协调' });
  assert.equal(value.ok, true);
  assert.equal(value.queued, true);
  assert.ok(value.id);
  assert.match(target.messages[0].content[0].text, /^\[session-bridge:协调\] 换到 qwen4-max 吧$/);
  assert.equal(target.messages[0].source.kind, 'user');
});

test('message：默认前缀；缺参数与未知会话报错', async () => {
  const target = makeAgent('session-b', null);
  const tools = createTools(makeCtx([target]));
  await tools.message.execute({ sessionId: 'session-b', text: '你好' });
  assert.match(target.messages[0].content[0].text, /^\[session-bridge\] 你好$/);
  await assert.rejects(() => tools.message.execute({ sessionId: 'session-b' }), /都是必填/);
  await assert.rejects(
    () => tools.message.execute({ sessionId: 'nope', text: 'x' }),
    /没有这个活会话：nope/,
  );
});

// ---- 渲染与注册 ---------------------------------------------------------

test('render：列表 / 目录 / 切换 / 消息都有可读文本', async () => {
  const target = makeAgent('session-b', { provider: 'deepseek-account', model: 'deepseek-flash' });
  const tools = createTools(makeCtx([target]));
  const listValue = await tools.list.execute({});
  assert.match(tools.list.output.render({}, listValue)[0].text, /活会话 1 个/);

  const catalogValue = await tools.catalog.execute({ provider: 'bailian-tpp' });
  const catalogText = tools.catalog.output.render({}, catalogValue)[0].text;
  assert.match(catalogText, /qwen4-max/);
  assert.match(catalogText, /ctx=128000/);

  const setValue = await tools.set.execute({ sessionId: 'session-b', provider: 'bailian-tpp', model: 'qwen4-max' });
  assert.match(
    tools.set.output.render({}, setValue)[0].text,
    /session-b: deepseek-account\/deepseek-flash → bailian-tpp\/qwen4-max/,
  );

  const messageValue = await tools.message.execute({ sessionId: 'session-b', text: 'hi' });
  assert.match(tools.message.output.render({}, messageValue)[0].text, /已入队/);
});

test('apply：注册四个工具，disposer 后注销', () => {
  const registered = [];
  const disposed = [];
  const ctx = makeCtx([makeAgent('session-a', null)]);
  ctx.tools = {
    register(definition) {
      registered.push(definition.name);
      return () => disposed.push(definition.name);
    },
  };
  let disposer;
  ctx.effect = (factory) => {
    disposer = factory();
  };
  apply(ctx);
  assert.deepEqual(registered, [
    'session_model_list',
    'session_model_catalog',
    'session_model_set',
    'session_message_send',
  ]);
  disposer();
  assert.equal(disposed.length, 4);
});

// ---- 按会话开关（B） -----------------------------------------------------

test('开关：未开启的会话不能换模型、不能发消息', async () => {
  const target = makeAgent('session-b', { provider: 'deepseek-account', model: 'deepseek-flash' });
  const tools = createTools(makeCtx([target]));
  try {
    setEnabled([]);
    await assert.rejects(
      () => tools.set.execute({ sessionId: 'session-b', provider: 'bailian-tpp', model: 'qwen4-max' }),
      /未开启跨会话换模型/,
    );
    await assert.rejects(
      () => tools.message.execute({ sessionId: 'session-b', text: 'hi' }),
      /未开启跨会话换模型/,
    );
    // 目标会话没被改动
    assert.deepEqual(target.model.current(), { provider: 'deepseek-account', model: 'deepseek-flash' });
    assert.equal(target.messages.length, 0);
  } finally {
    setEnabled(ENABLED);
  }
});

test('开关：只读查询不受开关影响', async () => {
  const tools = createTools(makeCtx([makeAgent('session-a', null)]));
  try {
    setEnabled([]);
    const list = await tools.list.execute({});
    assert.equal(list.sessions.length, 1);
    const catalog = await tools.catalog.execute({ provider: 'deepseek-account' });
    assert.equal(catalog.providers.length, 1);
  } finally {
    setEnabled(ENABLED);
  }
});

test('开关：开启后写操作放行', async () => {
  const target = makeAgent('session-b', { provider: 'deepseek-account', model: 'deepseek-flash' });
  const tools = createTools(makeCtx([target], { caller: { id: 'session-a' } }));
  try {
    setEnabled(['session-a']);
    const value = await tools.set.execute({ sessionId: 'session-b', provider: 'bailian-tpp', model: 'qwen4-max' });
    assert.equal(value.ok, true);
  } finally {
    setEnabled(ENABLED);
  }
});
