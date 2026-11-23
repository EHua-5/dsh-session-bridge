/**
 * session-model：让一个会话给另一个**活着的**会话换模型，并能跨会话说一句话。
 *
 * 四个工具：
 *   session_model_list     → 活会话 + 当前模型 + 上一次请求实际用的模型（能看出"切了还没生效"）
 *   session_model_catalog  → 可调模型列表（provider / model / 上下文窗口 / 推理强度 / 输入模态）
 *   session_model_set      → 给指定会话换模型；默认顺手通知对方（notify:false 可关）
 *   session_message_send   → 把一条消息投进另一个活会话，用于跨会话沟通
 *
 * 原理（DSH 0.2.x）：
 *   · 模型选择是会话里的持久投影（projection `modelSelection`），由
 *     `agent.model.select({provider, model, reasoningEffort?})` 追加一条 `model/selection` 事件；
 *   · 下一次模型请求的 header 用它，DSH 会在切换点自动往历史里插一条「model changed」提示；
 *   · 合法性用 `ctx.llm.resolveCallConfig()` 校验，和 UI 换模型同一条路径；
 *   · 跨会话消息走 `agent.followup()`：同步入队、排到下一轮，会话忙也不会丢（和 inbox-bridge 同一条路）。
 *
 * 边界：只能换**活会话**；不碰 agent 预设、默认模型和历史；消息以用户消息身份进入对方历史。
 */
import { FeatureStore, defaultFeaturesFile, deliver } from './shared.js';

export const name = 'session-model';

/** tools：注册工具；agents：找目标会话与调用方；llm：校验并读取模型目录。 */
export const inject = ['agents', 'tools', 'llm'];

/** 模型目录的单次查询上限，避免某个 provider 卡住整个工具调用。 */
const PROVIDER_TIMEOUT_MS = 4000;
const MODEL_INFO_TIMEOUT_MS = 4000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时 ${ms}ms`)), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function currentSelection(agent) {
  try {
    const selection = agent && agent.model && typeof agent.model.current === 'function' ? agent.model.current() : null;
    return selection || null;
  } catch {
    return null;
  }
}

/** 上一次真正发出去的请求用的模型（会话 header），没有就是 null。 */
function lastUsedSelection(agent) {
  try {
    const header = agent && agent.session && typeof agent.session.requestHeader === 'function'
      ? agent.session.requestHeader()
      : undefined;
    const config = header && header.config;
    if (!config) return null;
    return {
      provider: config.provider,
      model: config.model,
      ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
    };
  } catch {
    return null;
  }
}

function sameRoute(left, right) {
  return Boolean(left && right) && left.provider === right.provider && left.model === right.model;
}

function routeText(selection) {
  return selection && selection.provider ? `${selection.provider}/${selection.model}` : '(未选择)';
}

function sessionView(agent) {
  const current = currentSelection(agent);
  const lastUsed = lastUsedSelection(agent);
  return {
    id: String(agent.id),
    busy: agent.status === 'running',
    provider: current ? current.provider : null,
    model: current ? current.model : null,
    reasoningEffort: current && current.reasoningEffort !== undefined ? current.reasoningEffort : null,
    // 已经选了、但还没被任何一次请求用过 = 切换尚未生效
    pending: Boolean(current) && Boolean(lastUsed) && !sameRoute(current, lastUsed),
    lastUsed,
  };
}

function renderList(args, value) {
  const lines = [`活会话 ${value.sessions.length} 个：`];
  for (const session of value.sessions) {
    const suffix = session.pending ? `  （上一轮实际：${routeText(session.lastUsed)}，切换待生效）` : '';
    lines.push(`· ${session.id}  ${session.busy ? 'busy' : 'idle'}  ${routeText(session)}${suffix}`);
  }
  return [{ type: 'text', text: lines.join('\n') }];
}

function renderCatalog(args, value) {
  const lines = [];
  for (const provider of value.providers) {
    if (provider.error) {
      lines.push(`· ${provider.id}: (读取失败) ${provider.error}`);
      continue;
    }
    lines.push(`· ${provider.id}（${provider.models.length} 个）`);
    for (const model of provider.models) {
      const bits = [];
      if (model.contextWindow) bits.push(`ctx=${model.contextWindow}`);
      if (model.reasoningEfforts && model.reasoningEfforts.length) bits.push(`effort=${model.reasoningEfforts.join('/')}`);
      if (model.defaultEffort) bits.push(`default=${model.defaultEffort}`);
      if (model.inputModalities && model.inputModalities.length) bits.push(`in=${model.inputModalities.join('+')}`);
      if (model.error) bits.push(`err=${model.error}`);
      lines.push(`  - ${model.id}${bits.length ? '  ' + bits.join('  ') : ''}`);
    }
  }
  return [{ type: 'text', text: lines.join('\n') || '（没有可调模型）' }];
}

function renderSet(args, value) {
  const effort = value.selected && value.selected.reasoningEffort ? ` (effort=${value.selected.reasoningEffort})` : '';
  return [
    {
      type: 'text',
      text:
        `${value.sessionId}: ${routeText(value.previous)} → ${routeText(value.selected)}${effort}，下一轮生效` +
        (value.notified ? '（已通知对方）' : ''),
    },
  ];
}

function renderMessage(args, value) {
  return [{ type: 'text', text: `${value.sessionId}: 已入队${value.queued ? '（对方忙，排到下一轮）' : ''}` }];
}

/**
 * 按一个 ctx 造工具定义（测试直接用它，不用起 Cordis）。
 * @param {{agents: any, llm: any}} ctx
 */
export function createTools(ctx, options = {}) {
  // 按会话的功能开关：和 inbox.js 共用同一份文件（客户端开关经 HTTP /features 读写）
  const features = new FeatureStore(
    options.featuresFile === undefined ? defaultFeaturesFile() : options.featuresFile,
    { log: () => {} },
  );

  function liveIds() {
    return ctx.agents.list().map((agent) => String(agent.id));
  }

  function requireAgent(sessionId) {
    const agent = ctx.agents.get(sessionId);
    if (!agent) throw new Error(`没有这个活会话：${sessionId}（活会话：${liveIds().join(', ') || '无'}）`);
    return agent;
  }

  async function resolveModel(provider, model) {
    const base = { id: model.id, name: model.name };
    try {
      const info = await withTimeout(
        Promise.resolve(ctx.llm.resolveModelInfo(provider, model.id)),
        MODEL_INFO_TIMEOUT_MS,
        `${provider}/${model.id} 元数据`,
      );
      return {
        ...base,
        contextWindow: info && info.context && info.context.contextWindow,
        reasoningEfforts: info && info.reasoning ? info.reasoning.efforts.map((effort) => effort.id) : [],
        defaultEffort: info && info.reasoning ? info.reasoning.defaultEffort : undefined,
        inputModalities: (info && info.inputModalities) || [],
      };
    } catch (error) {
      return { ...base, error: String((error && error.message) || error) };
    }
  }

  async function catalog(providerFilter) {
    const providers = [];
    for (const provider of ctx.llm.listProviders()) {
      if (providerFilter && provider.id !== providerFilter) continue;
      try {
        const models = await withTimeout(
          Promise.resolve(ctx.llm.listModels(provider.id)),
          PROVIDER_TIMEOUT_MS,
          `${provider.id} 模型列表`,
        );
        const list = (models || []).map((model) => ({ id: model.id, name: model.name }));
        const detailed = await Promise.all(list.map((model) => resolveModel(provider.id, model)));
        providers.push({ id: provider.id, name: provider.name, models: detailed });
      } catch (error) {
        providers.push({
          id: provider.id,
          name: provider.name,
          models: [],
          error: String((error && error.message) || error),
        });
      }
    }
    return { providers };
  }

  function callerId() {
    try {
      const caller = ctx.agents.currentInitiator ? ctx.agents.currentInitiator() : undefined;
      return caller && caller.id ? String(caller.id) : '';
    } catch {
      return '';
    }
  }

  /** 发一条消息（前缀与 inbox 一致），返回 { id, queued }。 */
  function sendMessage(agent, text, source) {
    return deliver(agent, text, source);
  }

  /**
   * 开关按"被操作方"生效：目标会话同意，别人才动得了它。
   * 自己操作自己不需要开关。
   */
  function requireTargetConsent(sessionId, action) {
    const me = callerId();
    if (me && me === sessionId) return me;
    if (!features.isEnabled(sessionId)) {
      throw new Error(
        `目标会话（${sessionId}）未允许别的会话${action}：请在对方的输入框模型菜单里打开「允许其他会话更换本会话的模型」`,
      );
    }
    return me;
  }

  const listTool = {
    name: 'session_model_list',
    description:
      '列出活会话、忙碌状态、当前模型，以及上一次请求实际使用的模型。' +
      '「切换待生效」表示已经选了新模型但还没有请求用过它。仅查看，不改任何状态。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderList },
    timeoutMs: 10000,
    async execute() {
      return { sessions: ctx.agents.list().map(sessionView) };
    },
  };

  const catalogTool = {
    name: 'session_model_catalog',
    description:
      '列出可以切换到的模型：provider、model id、上下文窗口、支持的推理强度与默认强度、输入模态。' +
      '空列表或读取失败的 provider 会标出原因。provider 参数可只看一个 provider。',
    parameters: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: '只列这个 provider 路由；不传则列全部' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderCatalog },
    timeoutMs: 30000,
    async execute(args) {
      const provider = args && args.provider ? String(args.provider) : '';
      const value = await catalog(provider);
      if (!value.providers.length) {
        throw new Error(`没有这个 provider：${provider}（已知：${ctx.llm.listProviders().map((item) => item.id).join(', ')}）`);
      }
      return value;
    },
  };

  const setTool = {
    name: 'session_model_set',
    description:
      '给指定会话换模型。只对活会话有效；provider/model 必须存在且可用，否则报错且不改动。' +
      '切换写入该会话的选择投影，下一次模型请求开始生效。默认会往对方会话投一条说明（notify:false 可关），' +
      '需目标会话已开启「允许其他会话更换本会话的模型」（在对方的模型菜单里打开）；自己改自己不受此限制。调用方不是目标会话时才通知。不确定 id 或可用模型时，先调 session_model_list / session_model_catalog。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '目标会话 id（session-…）' },
        provider: { type: 'string', description: 'provider 路由，如 deepseek-account' },
        model: { type: 'string', description: '该 provider 下的 model id' },
        reasoningEffort: { type: 'string', description: '可选；该模型支持的推理强度 id，不传则用适配器默认' },
        notify: { type: 'boolean', description: '切换后是否通知对方会话，默认 true（仅跨会话时）' },
        note: { type: 'string', description: '可选；附在通知里的说明' },
      },
      required: ['sessionId', 'provider', 'model'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderSet },
    timeoutMs: 20000,
    async execute(args) {
      const sessionId = String((args && args.sessionId) || '');
      const provider = String((args && args.provider) || '');
      const model = String((args && args.model) || '');
      if (!sessionId || !provider || !model) throw new Error('sessionId / provider / model 都是必填');
      const agent = requireAgent(sessionId);
      const me = requireTargetConsent(sessionId, '更换它的模型');
      if (!agent.model || typeof agent.model.select !== 'function') {
        throw new Error(`会话 ${sessionId} 没有模型选择接口，无法切换`);
      }
      const selection = { provider, model };
      if (args.reasoningEffort !== undefined) selection.reasoningEffort = String(args.reasoningEffort);
      try {
        await ctx.llm.resolveCallConfig(selection);
      } catch (error) {
        const effort = selection.reasoningEffort ? `（effort=${selection.reasoningEffort}）` : '';
        throw new Error(`模型不可用：${provider}/${model}${effort} — ${(error && error.message) || error}`);
      }
      const previous = currentSelection(agent);
      agent.model.select(selection);
      const selected = currentSelection(agent) || selection;

      // 路由没变就不通知：no-op 切换不该把对方唤醒
      const changed = !(previous && previous.provider === selected.provider && previous.model === selected.model);
      const notify = args.notify !== false && changed && (!me || me !== sessionId);
      let notified = false;
      if (notify) {
        const note = args.note ? ` ${String(args.note)}` : '';
        sendMessage(
          agent,
          `${me ? me + ' ' : ''}已把你的模型从 ${routeText(previous)} 切到 ${routeText(selected)}，下一轮生效。${note}`.trim(),
          'model',
        );
        notified = true;
      }
      return { ok: true, sessionId, previous, selected, changed, appliedAt: 'next-step', notified };
    },
  };

  const messageTool = {
    name: 'session_message_send',
    description:
      '把一条文字消息投进另一个活会话（作为用户消息入队，对方忙就排到下一轮）。' +
      '用于跨会话沟通：请对方配合换模型、通知对方模型已切换、或让两个会话直接对话。' +
      '消息以用户消息身份进入对方历史，会让对方开一轮处理。需目标会话已开启「允许其他会话更换本会话的模型」。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '目标会话 id（session-…）' },
        text: { type: 'string', description: '消息正文' },
        source: { type: 'string', description: '可选标签，最多 40 字；渲染成 [session-bridge:<source>] ' },
      },
      required: ['sessionId', 'text'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderMessage },
    timeoutMs: 10000,
    async execute(args) {
      const sessionId = String((args && args.sessionId) || '');
      const text = String((args && args.text) || '').trim();
      if (!sessionId || !text) throw new Error('sessionId / text 都是必填');
      const agent = requireAgent(sessionId);
      requireTargetConsent(sessionId, '给它发消息');
      const source = String((args && args.source) || '').trim().slice(0, 40);
      const sent = sendMessage(agent, text, source);
      return { ok: true, sessionId, id: sent.id, queued: sent.queued };
    },
  };

  return { list: listTool, catalog: catalogTool, set: setTool, message: messageTool };
}

export function apply(ctx) {
  const tools = createTools(ctx);
  ctx.effect(() => {
    const disposers = Object.values(tools).map((tool) => ctx.tools.register(tool));
    return () => {
      for (const dispose of disposers) {
        try {
          if (typeof dispose === 'function') dispose();
        } catch {
          // 已卸载
        }
      }
    };
  });
}
