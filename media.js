/**
 * 生成类工具：图片 / 视频 / 音频，支持按 provider 路由到不同厂商的原生接口。
 *
 * config.providers 是"可以调用生成能力的 provider 表"（键是 llm provider id）：
 *   providers:
 *     ark:        { kind: ark,       host: https://ark.cn-beijing.volces.com, apiKeyEnv: ARK_API_KEY }
 *     openai:     { kind: openai,    host: https://api.openai.com,            apiKeyEnv: OPENAI_API_KEY }
 *     bailian-tpp:{ kind: dashscope, host: https://token-plan.cn-beijing.maas.aliyuncs.com, apiKeyEnv: BAILIAN_TPP_API_KEY }
 * 没写 providers 时退回旧的单后端配置（provider/host/apiKeyEnv/apiKey），默认 dashscope。
 *
 * 工具调用时 model 用 "provider/model"（如 ark/doubao-seedream-5-0-…）或省略走 defaultProvider。
 *
 * 适配器：
 *  - dashscope：图 chat/completions；视频异步任务；音频 SpeechSynthesizer
 *  - openai：图 /v1/images/generations（b64_json，回退 url）；音频 /v1/audio/speech；视频不支持
 *  - ark：图 /api/v3/images/generations；视频 /api/v3/contents/generations/tasks + 轮询；音频不支持
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MEDIA_PATTERN = /(image|video|audio|tts|asr|speech|transcri|seedream|seedance|sora|dall-e|flux|imagen|veo|embedding|rerank|moderation|ocr)/i;

const DEFAULT_DASHSCOPE_HOST = 'https://token-plan.cn-beijing.maas.aliyuncs.com';
const DEFAULT_OPENAI_HOST = 'https://api.openai.com';
const DEFAULT_ARK_HOST = 'https://ark.cn-beijing.volces.com';

function mediaKindOf(id, name) {
  const value = `${id || ''} ${name || ''}`;
  if (/(image|seedream|dall-e|flux|imagen|ocr)/i.test(value)) return 'image';
  if (/(video|seedance|sora|veo)/i.test(value)) return 'video';
  if (/(audio|tts|asr|speech|transcri)/i.test(value)) return 'audio';
  if (MEDIA_PATTERN.test(value)) return 'media';
  return 'chat';
}

function detectKind(host) {
  const value = String(host || '').toLowerCase();
  if (value.includes('ark.cn-beijing.volces.com') || value.includes('bytepluses')) return 'ark';
  if (value.includes('dashscope') || value.includes('maas.aliyuncs.com') || value.includes('token-plan')) return 'dashscope';
  return 'openai';
}

function defaultHostOf(kind) {
  if (kind === 'ark') return DEFAULT_ARK_HOST;
  if (kind === 'openai') return DEFAULT_OPENAI_HOST;
  return DEFAULT_DASHSCOPE_HOST;
}

/** 归一化出的 provider 表：kind/host/apiKeyEnv。没有 providers 时用旧的单后端配置。 */
function providerTable(config) {
  const table = {};
  const source = (config && config.providers) || {};
  for (const [id, entry] of Object.entries(source)) {
    if (!entry || typeof entry !== 'object') continue;
    const host = String(entry.host || defaultHostOf(entry.kind)).replace(/\/+$/, '');
    const kind = entry.kind && ['ark', 'openai', 'dashscope'].includes(entry.kind) ? entry.kind : detectKind(host);
    table[id] = { kind, host, apiKeyEnv: entry.apiKeyEnv, apiKey: entry.apiKey, imageModel: entry.imageModel, videoModel: entry.videoModel, audioModel: entry.audioModel, voice: entry.voice };
  }
  if (Object.keys(table).length > 0) return table;
  // 旧配置兼容：provider/host/apiKeyEnv/apiKey；没写 host 时保持旧的 dashscope 默认
  const legacyKind = config && config.provider && ['ark', 'openai', 'dashscope'].includes(config.provider)
    ? config.provider
    : (config && config.host ? detectKind(config.host) : 'dashscope');
  const legacyId = legacyKind === 'dashscope' && !(config && config.provider) ? '__default' : legacyKind;
  table[legacyId] = {
    kind: legacyKind,
    host: String((config && config.host) || defaultHostOf(legacyKind)).replace(/\/+$/, ''),
    apiKeyEnv: (config && config.apiKeyEnv) || 'BAILIAN_TPP_API_KEY',
    apiKey: config && config.apiKey,
    imageModel: config && config.imageModel,
    videoModel: config && config.videoModel,
    audioModel: config && config.audioModel,
    voice: config && config.voice,
  };
  return table;
}

function parseModelRef(modelArg) {
  const value = String(modelArg || '').trim();
  if (!value) return undefined;
  const slash = value.indexOf('/');
  if (slash > 0) return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
  return { model: value };
}

function pickRoute(config, modelArg) {
  const table = providerTable(config);
  const parsed = parseModelRef(modelArg) || {};
  let providerId = parsed.provider || (config && config.defaultProvider) || '';
  if (!providerId) {
    const ids = Object.keys(table);
    if (ids.length === 1) providerId = ids[0];
  }
  if (providerId && !table[providerId] && table.__default !== undefined) providerId = '__default';
  const entry = providerId ? table[providerId] : undefined;
  if (!entry) {
    throw new Error(
      `没有可用的生成 provider：请在 media.config.providers 里配置（键为 llm provider id），` +
        `或给 model 写成 "provider/model"。已配置：${Object.keys(table).join(', ') || '(空)'}`,
    );
  }
  return { providerId: providerId || '__default', entry, model: parsed.model };
}

function defaultImageModel(kind) {
  if (kind === 'openai') return 'gpt-image-1';
  if (kind === 'dashscope') return 'wan2.7-image';
  return undefined; // ark 的 seedream 版本号多，必须显式指定
}

function defaultVideoModel(kind) {
  if (kind === 'dashscope') return 'wan3.0-video';
  return undefined; // ark 的 seedance 版本号多，必须显式指定
}

function defaultAudioModel(kind) {
  if (kind === 'openai') return 'tts-1';
  if (kind === 'dashscope') return 'qwen-audio-3.0-tts-plus';
  return undefined;
}

function defaultOutputDir() {
  return join(homedir(), '.dsh', 'generated');
}

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
  return dir;
}

async function resolveKey(ctx, entry) {
  const envName = entry.apiKeyEnv;
  if (entry.apiKey) return String(entry.apiKey);
  if (envName && process.env[envName]) return process.env[envName];
  const credentials = ctx && ctx.credentials;
  if (envName && credentials && typeof credentials.resolve === 'function') {
    const resolved = await credentials.resolve(envName);
    if (resolved && resolved.value) return resolved.value;
  }
  throw new Error(`找不到 ${envName || 'apiKey'}：可在 media.config.providers.<id> 里配置 apiKey，或放进环境变量/凭据库`);
}

async function request(url, method, headers, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (!response.ok) {
      const text = new TextDecoder().decode(buffer.slice(0, 500));
      throw new Error(`HTTP ${response.status}: ${text}`);
    }
    return { buffer, contentType: response.headers.get('content-type') || '' };
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(url, headers, body, timeoutMs) {
  const { buffer } = await request(url, 'POST', headers, body, timeoutMs);
  const text = new TextDecoder().decode(buffer);
  return text ? JSON.parse(text) : {};
}

async function getJson(url, headers, timeoutMs) {
  const { buffer } = await request(url, 'GET', headers, undefined, timeoutMs);
  const text = new TextDecoder().decode(buffer);
  return text ? JSON.parse(text) : {};
}

async function download(url, file, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    await ensureDir(join(file, '..'));
    await writeFile(file, bytes);
    return { file, bytes: bytes.byteLength };
  } finally {
    clearTimeout(timer);
  }
}

async function saveBytes(file, bytes) {
  await ensureDir(join(file, '..'));
  await writeFile(file, bytes);
  return { file, bytes: bytes.byteLength };
}

function stamp() {
  const now = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`;
}

function fileOf(dir, kind, ext) {
  return join(dir, `${kind}-${stamp()}.${ext}`);
}

function decodeBase64(value) {
  return Buffer.from(String(value).replace(/^data:[^,]+,/, ''), 'base64');
}

async function imageBlock(ctx, bytes, mediaType) {
  const attachments = ctx && ctx.attachments;
  if (!attachments || typeof attachments.saveImages !== 'function') return null;
  try {
    const [ref] = await attachments.saveImages([{ data: bytes, mediaType }]);
    return ref ? { type: 'image', attachment: ref } : null;
  } catch {
    return null;
  }
}

async function fileBlock(ctx, file, mediaType) {
  const attachments = ctx && ctx.attachments;
  if (!attachments || typeof attachments.saveFile !== 'function') return null;
  try {
    const data = await readFile(file);
    const ref = await attachments.saveFile({ data, mediaType, name: file.split(/[\\/]/).pop() });
    return ref ? { type: 'file', attachment: ref } : null;
  } catch {
    return null;
  }
}

function textBlock(text) {
  return { type: 'text', text };
}

async function makeImage(ctx, config, route, prompt, opts) {
  const { entry, model } = route;
  const dir = await ensureDir(config.outputDir || defaultOutputDir());
  const key = await resolveKey(ctx, entry);
  const auth = { authorization: `Bearer ${key}` };
  if (!model) throw new Error('image_generate 需要 model（如 provider/model）');

  if (entry.kind === 'openai') {
    const body = { model, prompt, n: 1, response_format: 'b64_json' };
    const data = await postJson(`${entry.host}/v1/images/generations`, auth, body, 150000);
    const item = (data.data || [])[0] || {};
    if (item.b64_json) return saveBytes(fileOf(dir, 'image', 'png'), decodeBase64(item.b64_json));
    if (item.url) return download(item.url, fileOf(dir, 'image', 'png'), 120000);
    throw new Error(`图片接口没有返回结果：${JSON.stringify(data).slice(0, 300)}`);
  }

  if (entry.kind === 'ark') {
    const body = { model, prompt };
    if (opts && opts.size) body.size = String(opts.size);
    const data = await postJson(`${entry.host}/api/v3/images/generations`, auth, body, 180000);
    const item = (data.data || [])[0] || {};
    if (item.b64_json) return saveBytes(fileOf(dir, 'image', 'png'), decodeBase64(item.b64_json));
    if (item.url) return download(item.url, fileOf(dir, 'image', 'png'), 120000);
    const content = (data.output && data.output.choices && data.output.choices[0] && data.output.choices[0].message && data.output.choices[0].message.content) || [];
    const imagePart = (Array.isArray(content) ? content : []).find((part) => part && part.image);
    if (imagePart) return download(imagePart.image, fileOf(dir, 'image', 'png'), 120000);
    throw new Error(`图片接口没有返回结果：${JSON.stringify(data).slice(0, 300)}`);
  }

  // dashscope
  const body = { model, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] };
  const data = await postJson(`${entry.host}/compatible-mode/v1/chat/completions`, auth, body, 150000);
  const content = (((data.output || {}).choices || [])[0] || {}).message?.content || [];
  const part = (Array.isArray(content) ? content : []).find((item) => item && item.type === 'image' && item.image);
  if (!part) throw new Error(`图片接口没有返回结果：${JSON.stringify(data).slice(0, 300)}`);
  return download(part.image, fileOf(dir, 'image', 'png'), 120000);
}

async function makeVideo(ctx, config, route, prompt, opts) {
  const { entry, model } = route;
  const dir = await ensureDir(config.outputDir || defaultOutputDir());
  const key = await resolveKey(ctx, entry);
  const auth = { authorization: `Bearer ${key}` };
  if (entry.kind === 'openai') throw new Error(`OpenAI 没有标准的视频生成接口（provider=${route.providerId}）`);
  if (!model) throw new Error('video_generate 需要 model（如 provider/model）');

  if (entry.kind === 'ark') {
    const content = [{ type: 'text', text: prompt }];
    if (opts && opts.imageUrl) content.unshift({ type: 'image_url', image_url: { url: String(opts.imageUrl) } });
    const submit = await postJson(`${entry.host}/api/v3/contents/generations/tasks`, auth, { model, content }, 60000);
    const taskId = submit.id || (submit.output && submit.output.task_id);
    if (!taskId) throw new Error(`提交失败：${JSON.stringify(submit).slice(0, 300)}`);
    const deadline = Date.now() + 360000;
    let videoUrl = '';
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));
      const status = await getJson(`${entry.host}/api/v3/contents/generations/tasks/${encodeURIComponent(taskId)}`, auth, 30000);
      const state = status.status || (status.output && status.output.task_status) || '';
      if (/succeeded|SUCCEEDED/i.test(state)) {
        videoUrl = (status.content && status.content.video_url) || status.video_url || (status.output && status.output.video_url) || '';
        break;
      }
      if (/failed|FAILED|canceled|CANCELED/i.test(state)) throw new Error(`任务失败：${JSON.stringify(status).slice(0, 400)}`);
    }
    if (!videoUrl) throw new Error(`任务超时或没有 video_url（task=${taskId}）`);
    return { saved: await download(videoUrl, fileOf(dir, 'video', 'mp4'), 180000), taskId };
  }

  // dashscope 异步任务
  const duration = Number((opts && opts.duration) || 3);
  const resolution = String((opts && opts.resolution) || '480P');
  const ratio = String((opts && opts.ratio) || 'adaptive');
  const input = { prompt };
  if (opts && opts.imageUrl) input.media = [{ type: 'first_frame', url: String(opts.imageUrl) }];
  const submit = await postJson(
    `${entry.host}/api/v1/services/aigc/video-generation/video-synthesis`,
    { authorization: `Bearer ${key}`, 'x-dashscope-async': 'enable' },
    { model, input, parameters: { resolution, ratio, duration, prompt_extend: false } },
    60000,
  );
  const taskId = (submit.output || {}).task_id;
  if (!taskId) throw new Error(`提交失败：${JSON.stringify(submit).slice(0, 300)}`);
  const deadline = Date.now() + 360000;
  let videoUrl = '';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const status = await getJson(`${entry.host}/api/v1/tasks/${encodeURIComponent(taskId)}`, { authorization: `Bearer ${key}` }, 30000);
    const out = status.output || {};
    if (out.task_status === 'SUCCEEDED') {
      videoUrl = out.video_url || '';
      break;
    }
    if (out.task_status === 'FAILED' || out.task_status === 'CANCELED') throw new Error(`任务 ${out.task_status}：${JSON.stringify(out).slice(0, 400)}`);
  }
  if (!videoUrl) throw new Error(`任务超时（task_id=${taskId}）`);
  return { saved: await download(videoUrl, fileOf(dir, 'video', 'mp4'), 180000), taskId };
}

async function makeAudio(ctx, config, route, text, opts) {
  const { entry, model } = route;
  const dir = await ensureDir(config.outputDir || defaultOutputDir());
  const key = await resolveKey(ctx, entry);
  const auth = { authorization: `Bearer ${key}` };
  if (!model) throw new Error('audio_generate 需要 model（如 provider/model）');
  if (entry.kind === 'ark') throw new Error(`火山方舟暂未适配 TTS 接口（provider=${route.providerId}）`);

  if (entry.kind === 'openai') {
    const format = String((opts && opts.format) || 'mp3');
    const voice = String((opts && opts.voice) || config.voice || 'alloy');
    const body = { model, input: text, voice, response_format: format };
    const { buffer } = await request(`${entry.host}/v1/audio/speech`, 'POST', auth, body, 90000);
    const saved = await saveBytes(fileOf(dir, 'audio', format), buffer);
    return { saved, format, voice };
  }

  const format = String((opts && opts.format) || 'mp3');
  const voice = String((opts && opts.voice) || config.voice || 'longanlingxin');
  const sampleRate = Number((opts && opts.sampleRate) || 22050);
  const data = await postJson(
    `${entry.host}/api/v1/services/audio/tts/SpeechSynthesizer`,
    auth,
    { model, input: { text, voice, format, sample_rate: sampleRate } },
    90000,
  );
  const audioUrl = ((data.output || {}).audio || {}).url;
  if (!audioUrl) throw new Error(`接口没有返回音频：${JSON.stringify(data).slice(0, 300)}`);
  return { saved: await download(audioUrl, fileOf(dir, 'audio', format), 60000), format, voice };
}

export function createMediaTools(ctx, options = {}) {
  const config = options || {};
  const table = providerTable(config);
  const configured = Object.keys(table).filter((id) => id !== '__default');
  const routeHint = configured.length ? `已配置 provider：${configured.join(', ')}；model 用 "provider/model"。` : '';

  const modelsTool = {
    name: 'media_models',
    description:
      '列出当前 DSH 里所有"能调用生成能力"的模型（按 provider 分组，标出 image/video/audio 类型），' +
      '以及哪些 provider 已在 media.config.providers 里配置好、可以直接调。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => {
        const lines = [];
        for (const provider of value.providers) {
          const mark = provider.callable ? '✓ 可调用' : '× 未配置生成端点';
          lines.push(`· ${provider.id}  ${mark}`);
          for (const model of provider.models) lines.push(`  - [${model.kind}] ${model.id}`);
        }
        lines.push('', value.note);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    timeoutMs: 15000,
    async execute() {
      const providers = (ctx.llm && ctx.llm.listProviders ? ctx.llm.listProviders() : []);
      const out = [];
      for (const provider of providers) {
        let models = [];
        try {
          models = await ctx.llm.listModels(provider.id);
        } catch {
          models = [];
        }
        const media = models
          .map((model) => ({ id: model.id, name: model.name, kind: mediaKindOf(model.id, model.name) }))
          .filter((model) => model.kind !== 'chat');
        if (media.length === 0) continue;
        out.push({ id: provider.id, callable: Boolean(table[provider.id]), models: media });
      }
      return {
        providers: out,
        note:
          '要让某个 provider 的生成模型可调用，在 media 插件 config.providers.<id> 里写 host + apiKeyEnv（或 apiKey）。' +
          ' 调用时 model 传 "provider/model"，例如 ark/doubao-seedream-5-0、openai/gpt-image-1。',
      };
    },
  };

  const imageTool = {
    name: 'image_generate',
    description: `用生图模型生成一张图片，保存到本地并返回文件路径（GUI 里会直接显示图片）。${routeHint}`,
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '图片描述（中文/英文均可）' },
        model: { type: 'string', description: '可选，"provider/model"（如 ark/doubao-seedream-5-0、openai/gpt-image-1）' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => {
        const blocks = [textBlock(`图片已生成：${value.file}（${value.bytes} 字节，${value.provider}/${value.model}）`)];
        if (value.block) blocks.push(value.block);
        else blocks.push(textBlock(`![${value.prompt}](${value.file})`));
        return blocks;
      },
    },
    timeoutMs: 240000,
    async execute(args) {
      const prompt = String((args && args.prompt) || '').trim();
      if (!prompt) throw new Error('prompt 必填');
      const route = pickRoute(config, args && args.model);
      route.model = route.model || route.entry.imageModel || config.imageModel || defaultImageModel(route.entry.kind);
      const saved = await makeImage(ctx, config, route, prompt, {});
      const bytes = await readFile(saved.file);
      const block = await imageBlock(ctx, bytes, 'image/png');
      return { ok: true, kind: 'image', provider: route.providerId, model: route.model, prompt, file: saved.file, bytes: saved.bytes, block };
    },
  };

  const videoTool = {
    name: 'video_generate',
    description: `用视频模型生成短视频（异步任务，通常 1–5 分钟），保存到本地并返回文件路径。${routeHint}`,
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '视频描述' },
        model: { type: 'string', description: '可选，"provider/model"（如 ark/doubao-seedance-…、bailian/wan3.0-video）' },
        duration: { type: 'number', description: '秒数（默认 3；越长越贵）' },
        resolution: { type: 'string', description: '480P / 720P / 1080P（默认 480P，dashscope 生效）' },
        ratio: { type: 'string', description: '比例，默认 adaptive（dashscope 生效）' },
        imageUrl: { type: 'string', description: '可选：首帧图片 URL（图生视频）' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => {
        const blocks = [textBlock(`视频已生成：${value.file}（${value.bytes} 字节，${value.provider}/${value.model}）`)];
        if (value.block) blocks.push(value.block);
        return blocks;
      },
    },
    timeoutMs: 480000,
    async execute(args) {
      const prompt = String((args && args.prompt) || '').trim();
      if (!prompt) throw new Error('prompt 必填');
      const route = pickRoute(config, args && args.model);
      route.model = route.model || route.entry.videoModel || config.videoModel || defaultVideoModel(route.entry.kind);
      const result = await makeVideo(ctx, config, route, prompt, args || {});
      const block = await fileBlock(ctx, result.saved.file, 'video/mp4');
      return { ok: true, kind: 'video', provider: route.providerId, model: route.model, prompt, taskId: result.taskId, file: result.saved.file, bytes: result.saved.bytes, block };
    },
  };

  const audioTool = {
    name: 'audio_generate',
    description: `用语音合成模型把文本转成音频（默认 mp3），保存到本地并返回文件路径。${routeHint}`,
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要合成的文本' },
        model: { type: 'string', description: '可选，"provider/model"（如 openai/tts-1、bailian/qwen-audio-3.0-tts-plus）' },
        voice: { type: 'string', description: '音色，覆盖默认值' },
        format: { type: 'string', description: 'mp3 / pcm / wav / opus，默认 mp3' },
        sampleRate: { type: 'number', description: '采样率，默认 22050（dashscope 生效）' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => {
        const blocks = [textBlock(`音频已生成：${value.file}（${value.bytes} 字节，${value.format}，${value.provider}/${value.model}）`)];
        if (value.block) blocks.push(value.block);
        return blocks;
      },
    },
    timeoutMs: 120000,
    async execute(args) {
      const text = String((args && args.text) || '').trim();
      if (!text) throw new Error('text 必填');
      const route = pickRoute(config, args && args.model);
      route.model = route.model || route.entry.audioModel || config.audioModel || defaultAudioModel(route.entry.kind);
      const result = await makeAudio(ctx, config, route, text, args || {});
      const block = await fileBlock(ctx, result.saved.file, result.format === 'wav' ? 'audio/wav' : result.format === 'opus' ? 'audio/opus' : 'audio/mpeg');
      return { ok: true, kind: 'audio', provider: route.providerId, model: route.model, voice: result.voice, format: result.format, file: result.saved.file, bytes: result.saved.bytes, block };
    },
  };

  return { models: modelsTool, image: imageTool, video: videoTool, audio: audioTool };
}

/** 注册四个工具；返回 disposer。 */
export function apply(ctx, config) {
  const tools = createMediaTools(ctx, config);
  const disposers = [
    ctx.tools.register(tools.models),
    ctx.tools.register(tools.image),
    ctx.tools.register(tools.video),
    ctx.tools.register(tools.audio),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}

export const name = 'media';
export const inject = ['tools', 'credentials', 'attachments'];
export { mediaKindOf, providerTable, DEFAULT_DASHSCOPE_HOST, DEFAULT_OPENAI_HOST, DEFAULT_ARK_HOST };
