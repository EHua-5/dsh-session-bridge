/**
 * 生成类工具：图片 / 视频 / 音频，按 provider 路由到各厂商原生接口。
 *
 * config.providers（键为 llm provider id）：
 *   providers:
 *     zhipu:   { kind: zhipu,   host: https://open.bigmodel.cn,        apiKeyEnv: ZHIPU_API_KEY }
 *     fal:     { kind: fal,     host: https://queue.fal.run,           apiKeyEnv: FAL_KEY }
 *     stability:{kind: stability,host: https://api.stability.ai,       apiKeyEnv: STABILITY_API_KEY }
 *     eleven:  { kind: elevenlabs,host: https://api.elevenlabs.io,     apiKeyEnv: ELEVENLABS_API_KEY, voice: <voice_id> }
 *     google:  { kind: google,  host: https://generativelanguage.googleapis.com, apiKeyEnv: GEMINI_API_KEY }
 *     replicate:{kind: replicate,host: https://api.replicate.com,      apiKeyEnv: REPLICATE_API_TOKEN }
 *     openai / dashscope / ark 见 document。
 *
 * 调用时 model 用 "provider/model"；extra 对象会合并进请求体（replicate 合并进 input）。
 * 未写 providers 时退回旧的单后端配置（provider/host/apiKeyEnv/apiKey），默认 dashscope。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MEDIA_PATTERN =
  /(image|video|audio|tts|asr|speech|transcri|seedream|seedance|sora|dall-e|flux|imagen|veo|cogview|cogvideo|stable-diffusion|sd3|embedding|rerank|moderation|ocr)/i;

const DEFAULT_DASHSCOPE_HOST = 'https://token-plan.cn-beijing.maas.aliyuncs.com';
const DEFAULT_OPENAI_HOST = 'https://api.openai.com';
const DEFAULT_ARK_HOST = 'https://ark.cn-beijing.volces.com';
const DEFAULT_ZHIPU_HOST = 'https://open.bigmodel.cn';
const DEFAULT_FAL_HOST = 'https://queue.fal.run';
const DEFAULT_STABILITY_HOST = 'https://api.stability.ai';
const DEFAULT_ELEVEN_HOST = 'https://api.elevenlabs.io';
const DEFAULT_GOOGLE_HOST = 'https://generativelanguage.googleapis.com';
const DEFAULT_REPLICATE_HOST = 'https://api.replicate.com';

const KINDS = ['openai', 'dashscope', 'ark', 'zhipu', 'fal', 'stability', 'elevenlabs', 'google', 'replicate'];

// Node 的 fetch 不走系统代理；需要时用 CONNECT 隧道（http/https 代理）
let ACTIVE_PROXY = '';

async function withProxy(entry, config, fn) {
  ACTIVE_PROXY = String((entry && entry.proxy) || (config && config.proxy) || '');
  try {
    return await fn();
  } finally {
    ACTIVE_PROXY = '';
  }
}

function proxyRequest(target, { method = 'GET', headers = {}, body }, proxyUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const proxy = new URL(proxyUrl);
    const isHttps = url.protocol === 'https:';
    const targetPort = url.port || (isHttps ? '443' : '80');
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error(`代理请求超时（${timeoutMs}ms）`)), timeoutMs);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const send = (socket) => {
      const request = http.request(
        {
          host: url.hostname,
          port: targetPort,
          path: `${url.pathname}${url.search}`,
          method,
          headers,
          ...(socket === undefined ? {} : { createConnection: () => socket }),
        },
        (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => finish({ status: response.statusCode, headers: response.headers, buffer: Buffer.concat(chunks) }));
        },
      );
      request.on('error', fail);
      if (body !== undefined) request.write(body);
      request.end();
    };

    if (!isHttps) {
      // 明文目标：代理走 absolute-form
      const request = http.request(
        { host: proxy.hostname, port: proxy.port || 80, path: target, method, headers },
        (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => finish({ status: response.statusCode, headers: response.headers, buffer: Buffer.concat(chunks) }));
        },
      );
      request.on('error', fail);
      if (body !== undefined) request.write(body);
      request.end();
      return;
    }

    const connect = http.request({
      host: proxy.hostname,
      port: proxy.port || 80,
      method: 'CONNECT',
      path: `${url.hostname}:${targetPort}`,
      headers: { host: `${url.hostname}:${targetPort}` },
    });
    connect.on('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        fail(new Error(`代理 CONNECT 失败 ${response.statusCode}`));
        return;
      }
      const secure = tls.connect({ socket, servername: url.hostname }, () => send(secure));
      secure.on('error', fail);
    });
    connect.on('error', fail);
    connect.end();
  });
}

function concatHeaders(base, extra) {
  return { ...base, ...(extra || {}) };
}

function serviceOf(ctx, name) {
  if (!ctx) return undefined;
  if (typeof ctx.get === 'function') return ctx.get(name);
  return ctx[name];
}

function mediaKindOf(id, name) {
  const value = `${id || ''} ${name || ''}`;
  if (/(image|seedream|cogview|dall-e|flux|imagen|stable-diffusion|sd3|ocr)/i.test(value)) return 'image';
  if (/(video|seedance|cogvideo|sora|veo)/i.test(value)) return 'video';
  if (/(audio|tts|asr|speech|transcri)/i.test(value)) return 'audio';
  if (MEDIA_PATTERN.test(value)) return 'media';
  return 'chat';
}

function detectKind(host) {
  const value = String(host || '').toLowerCase();
  if (value.includes('open.bigmodel.cn')) return 'zhipu';
  if (value.includes('fal.run') || value.includes('fal.ai')) return 'fal';
  if (value.includes('stability.ai')) return 'stability';
  if (value.includes('elevenlabs.io')) return 'elevenlabs';
  if (value.includes('generativelanguage.googleapis.com') || value.includes('googleapis.com')) return 'google';
  if (value.includes('replicate.com')) return 'replicate';
  if (value.includes('ark.cn-beijing.volces.com') || value.includes('bytepluses')) return 'ark';
  if (value.includes('dashscope') || value.includes('maas.aliyuncs.com') || value.includes('token-plan')) return 'dashscope';
  return 'openai';
}

function defaultHostOf(kind) {
  return {
    ark: DEFAULT_ARK_HOST,
    zhipu: DEFAULT_ZHIPU_HOST,
    fal: DEFAULT_FAL_HOST,
    stability: DEFAULT_STABILITY_HOST,
    elevenlabs: DEFAULT_ELEVEN_HOST,
    google: DEFAULT_GOOGLE_HOST,
    replicate: DEFAULT_REPLICATE_HOST,
    openai: DEFAULT_OPENAI_HOST,
    dashscope: DEFAULT_DASHSCOPE_HOST,
  }[kind] || DEFAULT_OPENAI_HOST;
}

function providerTable(config) {
  const table = {};
  const source = (config && config.providers) || {};
  for (const [id, entry] of Object.entries(source)) {
    if (!entry || typeof entry !== 'object') continue;
    const host = String(entry.host || defaultHostOf(entry.kind)).replace(/\/+$/, '');
    const kind = entry.kind && KINDS.includes(entry.kind) ? entry.kind : detectKind(host);
    table[id] = { kind, host, ...entry, host };
  }
  if (Object.keys(table).length > 0) return table;
  const legacyKind = config && config.provider && KINDS.includes(config.provider)
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

function pickRoute(config, modelArg, modality) {
  const table = providerTable(config);
  const parsed = parseModelRef(modelArg) || {};
  let providerId = parsed.provider || (config && config.defaultProvider) || '';
  if (!providerId) {
    const ids = Object.keys(table);
    if (ids.length === 1) providerId = ids[0];
    else if (modality) {
      // 多 provider 且调用方没指定时，挑第一个支持该模态的（按配置顺序，确定性）
      providerId = ids.find((id) => {
        const adapter = ADAPTERS[table[id].kind];
        return Boolean(adapter && adapter[modality]);
      }) || '';
    }
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
  const credentials = serviceOf(ctx, 'credentials');
  if (envName && credentials && typeof credentials.resolve === 'function') {
    const resolved = await credentials.resolve(envName);
    if (resolved && resolved.value) return resolved.value;
  }
  throw new Error(`找不到 ${envName || 'apiKey'}：可在 media.config.providers.<id> 里配置 apiKey，或放进环境变量/凭据库`);
}

async function request(url, method, headers, body, timeoutMs) {
  if (ACTIVE_PROXY) {
    const result = await proxyRequest(url, { method, headers, body }, ACTIVE_PROXY, timeoutMs);
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`HTTP ${result.status}: ${result.buffer.subarray(0, 500).toString('utf8')}`);
    }
    return { buffer: result.buffer, contentType: result.headers['content-type'] || '' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method, headers, body, signal: controller.signal });
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${new TextDecoder().decode(buffer.slice(0, 500))}`);
    }
    return { buffer, contentType: response.headers.get('content-type') || '' };
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(url, headers, body, timeoutMs) {
  const { buffer } = await request(url, 'POST', { 'content-type': 'application/json', ...headers }, JSON.stringify(body), timeoutMs);
  const text = new TextDecoder().decode(buffer);
  return text ? JSON.parse(text) : {};
}

async function getJson(url, headers, timeoutMs) {
  const { buffer } = await request(url, 'GET', headers, undefined, timeoutMs);
  const text = new TextDecoder().decode(buffer);
  return text ? JSON.parse(text) : {};
}

async function download(url, file, timeoutMs, headers) {
  if (ACTIVE_PROXY) {
    const result = await proxyRequest(url, { method: 'GET', headers }, ACTIVE_PROXY, timeoutMs);
    if (result.status < 200 || result.status >= 300) throw new Error(`下载失败 HTTP ${result.status}`);
    await ensureDir(join(file, '..'));
    await writeFile(file, result.buffer);
    return { file, bytes: result.buffer.byteLength };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
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

function pcmToWav(pcm, sampleRate = 24000, channels = 1, bits = 16) {
  const data = Buffer.from(pcm);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE((sampleRate * channels * bits) / 8, 28);
  header.writeUInt16LE((channels * bits) / 8, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function decodeBase64(value) {
  return Buffer.from(String(value).replace(/^data:[^,]+,/, ''), 'base64');
}

function mergeExtra(body, extra) {
  if (!extra || typeof extra !== 'object') return body;
  return { ...body, ...extra };
}

async function pollUntil(fn, done, deadlineMs, intervalMs = 5000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const value = await fn();
    if (done(value)) return value;
  }
  throw new Error('轮询超时');
}

async function imageBlock(ctx, bytes, mediaType) {
  const attachments = serviceOf(ctx, 'attachments');
  if (!attachments || typeof attachments.saveImages !== 'function') return null;
  try {
    const [ref] = await attachments.saveImages([{ data: bytes, mediaType }]);
    return ref ? { type: 'image', attachment: ref } : null;
  } catch {
    return null;
  }
}

async function fileBlock(ctx, file, mediaType) {
  const attachments = serviceOf(ctx, 'attachments');
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

/* ------------------------------ 图片 ------------------------------ */

async function image_openai(ctx, config, route, prompt, opts) {
  const key = await resolveKey(ctx, route.entry);
  const body = mergeExtra({ model: route.model, prompt, n: 1, response_format: 'b64_json' }, opts.extra);
  const data = await postJson(`${route.entry.host}/v1/images/generations`, { authorization: `Bearer ${key}` }, body, 150000);
  const item = (data.data || [])[0] || {};
  const dir = await ensureDir(config.outputDir || defaultOutputDir());
  if (item.b64_json) return saveBytes(fileOf(dir, 'image', 'png'), decodeBase64(item.b64_json));
  if (item.url) return download(item.url, fileOf(dir, 'image', 'png'), 120000);
  throw new Error(`图片接口没有返回结果：${JSON.stringify(data).slice(0, 300)}`);
}

async function image_dashscope(ctx, config, route, prompt, opts) {
  const key = await resolveKey(ctx, route.entry);
  const body = mergeExtra({ model: route.model, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] }, opts.extra);
  const data = await postJson(`${route.entry.host}/compatible-mode/v1/chat/completions`, { authorization: `Bearer ${key}` }, body, 150000);
  const content = (((data.output || {}).choices || [])[0] || {}).message?.content || [];
  const part = (Array.isArray(content) ? content : []).find((item) => item && item.type === 'image' && item.image);
  if (!part) throw new Error(`图片接口没有返回结果：${JSON.stringify(data).slice(0, 300)}`);
  const dir = await ensureDir(config.outputDir || defaultOutputDir());
  return download(part.image, fileOf(dir, 'image', 'png'), 120000);
}

async function image_ark(ctx, config, route, prompt, opts) {
  const key = await resolveKey(ctx, route.entry);
  const body = mergeExtra({ model: route.model, prompt }, opts.extra);
  const data = await postJson(`${route.entry.host}/api/v3/images/generations`, { authorization: `Bearer ${key}` }, body, 180000);
  const dir = await ensureDir(config.outputDir || defaultOutputDir());
  const item = (data.data || [])[0] || {};
  if (item.b64_json) return saveBytes(fileOf(dir, 'image', 'png'), decodeBase64(item.b64_json));
  if (item.url) return download(item.url, fileOf(dir, 'image', 'png'), 120000);
  throw new Error(`图片接口没有返回结果：${JSON.stringify(data).slice(0, 300)}`);
}

async function image_zhipu(ctx, config, route, prompt, opts) {
  const key = await resolveKey(ctx, route.entry);
  const body = mergeExtra({ model: route.model, prompt }, opts.extra);
  const data = await postJson(`${route.entry.host}/api/paas/v4/images/generations`, { authorization: `Bearer ${key}` }, body, 180000);
  const dir = await ensureDir(config.outputDir || defaultOutputDir());
  const item = (data.data || [])[0] || {};
  if (item.url) return download(item.url, fileOf(dir, 'image', 'png'), 120000);
  if (item.b64_json) return saveBytes(fileOf(dir, 'image', 'png'), decodeBase64(item.b64_json));
  throw new Error(`图片接口没有返回结果：${JSON.stringify(data).slice(0, 300)}`);
}

async function image_stability(ctx, config, route, prompt, opts) {
  const key = await resolveKey(ctx, route.entry);
  const form = new FormData();
  form.append('prompt', prompt);
  form.append('output_format', 'png');
  for (const [name, value] of Object.entries(opts.extra || {})) {
    if (value !== undefined && value !== null) form.append(name, String(value));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000);
  try {
    const response = await fetch(`${route.entry.host}/v2beta/stable-image/generate/core`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, accept: 'image/*' },
      body: form,
      signal: controller.signal,
    });
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${new TextDecoder().decode(buffer.slice(0, 400))}`);
    const dir = await ensureDir(config.outputDir || defaultOutputDir());
    return saveBytes(fileOf(dir, 'image', 'png'), buffer);
  } finally {
    clearTimeout(timer);
  }
}

async function image_fal(ctx, config, route, prompt, opts) {
  const model = route.model || route.entry.imageModel;
  if (!model) throw new Error('fal 图片需要在 config/route 里给 model（fal 模型路径，如 fal-ai/flux/schnell）');
  const result = await falRun(ctx, config, route, model, mergeExtra({ prompt }, opts.extra), (data) => {
    const first = (data.images || [])[0] || {};
    return first.url || data.image?.url || '';
  }, 'png', 180000);
  return result.saved;
}

async function image_google(ctx, config, route, prompt, opts) {
  const key = await resolveKey(ctx, route.entry);
  const model = route.model || route.entry.imageModel;
  if (!model) throw new Error('google 图片需要 model（如 imagen-4.0-generate-001 或 gemini-*-image）');
  const dir = await ensureDir(config.outputDir || defaultOutputDir());

  // Imagen 系走 :predict；Gemini 原生图片模型走 :generateContent
  if (/imagen/i.test(model)) {
    const body = mergeExtra({ instances: [{ prompt }], parameters: { sampleCount: 1 } }, opts.extra);
    const data = await postJson(
      `${route.entry.host}/v1beta/models/${encodeURIComponent(model)}:predict?key=${encodeURIComponent(key)}`,
      {},
      body,
      180000,
    );
    const item = (data.predictions || [])[0] || {};
    if (item.bytesBase64Encoded) return saveBytes(fileOf(dir, 'image', 'png'), decodeBase64(item.bytesBase64Encoded));
    if (item.uri) return download(item.uri, fileOf(dir, 'image', 'png'), 120000, { 'x-goog-api-key': key });
    throw new Error(`图片接口没有返回结果：${JSON.stringify(data).slice(0, 300)}`);
  }

  const body = mergeExtra(
    { contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } },
    opts.extra,
  );
  const data = await postJson(
    `${route.entry.host}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
    {},
    body,
    180000,
  );
  const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  const inline = parts.find((part) => part && part.inlineData && part.inlineData.data);
  if (!inline) throw new Error(`图片接口没有返回结果：${JSON.stringify(data).slice(0, 300)}`);
  const mime = inline.inlineData.mimeType || 'image/png';
  const ext = mime.includes('jpeg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png';
  return saveBytes(fileOf(dir, 'image', ext), decodeBase64(inline.inlineData.data));
}

async function image_replicate(ctx, config, route, prompt, opts) {
  const result = await replicateRun(ctx, config, route, mergeExtra({ prompt }, opts.extra), 'png', 240000);
  return result.saved;
}

/* ------------------------------ 视频 ------------------------------ */

async function video_dashscope(ctx, config, route, prompt, opts) {
  const key = await resolveKey(ctx, route.entry);
  const duration = Number((opts && opts.duration) || 3);
  const resolution = String((opts && opts.resolution) || '480P');
  const ratio = String((opts && opts.ratio) || 'adaptive');
  const input = { prompt };
  if (opts && opts.imageUrl) input.media = [{ type: 'first_frame', url: String(opts.imageUrl) }];
  const submit = await postJson(
    `${route.entry.host}/api/v1/services/aigc/video-generation/video-synthesis`,
    { authorization: `Bearer ${key}`, 'x-dashscope-async': 'enable' },
    mergeExtra({ model: route.model, input, parameters: { resolution, ratio, duration, prompt_extend: false } }, opts.extra),
    60000,
  );
  const taskId = (submit.output || {}).task_id;
  if (!taskId) throw new Error(`提交失败：${JSON.stringify(submit).slice(0, 300)}`);
  const final = await pollUntil(
    () => getJson(`${route.entry.host}/api/v1/tasks/${encodeURIComponent(taskId)}`, { authorization: `Bearer ${key}` }, 30000),
    (value) => {
      const status = (value.output || {}).task_status;
      if (status === 'FAILED' || status === 'CANCELED') throw new Error(`任务 ${status}：${JSON.stringify(value.output).slice(0, 400)}`);
      return status === 'SUCCEEDED';
    },
    360000,
  );
  const videoUrl = (final.output || {}).video_url;
  if (!videoUrl) throw new Error('任务成功但没有 video_url');
  const dir = await ensureDir(config.outputDir || defaultOutputDir());
  return { saved: await download(videoUrl, fileOf(dir, 'video', 'mp4'), 180000), taskId };
}

async function video_ark(ctx, config, route, prompt, opts) {
  const key = await resolveKey(ctx, route.entry);
  const content = [{ type: 'text', text: prompt }];
  if (opts && opts.imageUrl) content.unshift({ type: 'image_url', image_url: { url: String(opts.imageUrl) } });
  const submit = await postJson(
    `${route.entry.host}/api/v3/contents/generations/tasks`,
    { authorization: `Bearer ${key}` },
    mergeExtra({ model: route.model, content }, opts.extra),
    60000,
  );
  const taskId = submit.id || (submit.output && submit.output.task_id);
  if (!taskId) throw new Error(`提交失败：${JSON.stringify(submit).slice(0, 300)}`);
  const final = await pollUntil(
    () => getJson(`${route.entry.host}/api/v3/contents/generations/tasks/${encodeURIComponent(taskId)}`, { authorization: `Bearer ${key}` }, 30000),
    (value) => {
      const state = value.status || (value.output && value.output.task_status) || '';
      if (/failed|canceled/i.test(state)) throw new Error(`任务失败：${JSON.stringify(value).slice(0, 400)}`);
      return /succeeded/i.test(state);
    },
    360000,
  );
  const videoUrl = (final.content && final.content.video_url) || final.video_url || (final.output && final.output.video_url);
  if (!videoUrl) throw new Error('任务成功但没有 video_url');
  const dir = await ensureDir(config.outputDir || defaultOutputDir());
  return { saved: await download(videoUrl, fileOf(dir, 'video', 'mp4'), 180000), taskId };
}

async function video_zhipu(ctx, config, route, prompt, opts) {
  const key = await resolveKey(ctx, route.entry);
  const submit = await postJson(
    `${route.entry.host}/api/paas/v4/videos/generations`,
    { authorization: `Bearer ${key}` },
    mergeExtra({ model: route.model, prompt }, opts.extra),
    60000,
  );
  const taskId = submit.id || submit.task_id;
  if (!taskId) throw new Error(`提交失败：${JSON.stringify(submit).slice(0, 300)}`);
  const final = await pollUntil(
    () => getJson(`${route.entry.host}/api/paas/v4/async-result/${encodeURIComponent(taskId)}`, { authorization: `Bearer ${key}` }, 30000),
    (value) => {
      const status = value.task_status || value.status || '';
      if (/fail/i.test(status)) throw new Error(`任务失败：${JSON.stringify(value).slice(0, 400)}`);
      return /success/i.test(status);
    },
    360000,
  );
  const results = final.video_result || final.data || [];
  const videoUrl = (Array.isArray(results) ? results[0] : results)?.url || final.video_url;
  if (!videoUrl) throw new Error('任务成功但没有视频 url');
  const dir = await ensureDir(config.outputDir || defaultOutputDir());
  return { saved: await download(videoUrl, fileOf(dir, 'video', 'mp4'), 180000), taskId };
}

async function video_fal(ctx, config, route, prompt, opts) {
  const model = route.model || route.entry.videoModel;
  if (!model) throw new Error('fal 视频需要在 config/route 里给 model（fal 模型路径）');
  return falRun(ctx, config, route, model, mergeExtra({ prompt }, opts.extra), (data) => {
    return (data.video && data.video.url) || (data.videos && data.videos[0] && data.videos[0].url) || '';
  }, 'mp4', 480000);
}

async function video_google(ctx, config, route, prompt, opts) {
  const key = await resolveKey(ctx, route.entry);
  const model = route.model || route.entry.videoModel;
  if (!model) throw new Error('google 视频需要 model（如 veo-3.1-generate-preview）');
  const submit = await postJson(
    `${route.entry.host}/v1beta/models/${encodeURIComponent(model)}:predictLongRunning?key=${encodeURIComponent(key)}`,
    {},
    mergeExtra({ instances: [{ prompt }], parameters: {} }, opts.extra),
    60000,
  );
  const opName = submit.name;
  if (!opName) throw new Error(`提交失败：${JSON.stringify(submit).slice(0, 300)}`);
  const final = await pollUntil(
    () => getJson(`${route.entry.host}/v1beta/${opName}?key=${encodeURIComponent(key)}`, {}, 30000),
    (value) => {
      if (value.done && value.error) throw new Error(`任务失败：${JSON.stringify(value.error).slice(0, 400)}`);
      return Boolean(value.done);
    },
    480000,
  );
  const samples = (final.response && final.response.generateVideoResponse && final.response.generateVideoResponse.generatedSamples) || [];
  const videoUri = (samples[0] && samples[0].video && samples[0].video.uri) || '';
  if (!videoUri) throw new Error('任务完成但没有视频 uri');
  const dir = await ensureDir(config.outputDir || defaultOutputDir());
  const url = videoUri.includes('key=') ? videoUri : `${videoUri}${videoUri.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}`;
  return { saved: await download(url, fileOf(dir, 'video', 'mp4'), 240000, { 'x-goog-api-key': key }), taskId: opName };
}

async function video_replicate(ctx, config, route, prompt, opts) {
  return replicateRun(ctx, config, route, mergeExtra({ prompt }, opts.extra), 'mp4', 480000);
}

/* ------------------------------ 音频 ------------------------------ */

async function audio_openai(ctx, config, route, text, opts) {
  const key = await resolveKey(ctx, route.entry);
  const format = String((opts && opts.format) || 'mp3');
  const voice = String((opts && opts.voice) || route.entry.voice || config.voice || 'alloy');
  const body = mergeExtra({ model: route.model, input: text, voice, response_format: format }, opts.extra);
  const { buffer } = await request(`${route.entry.host}/v1/audio/speech`, 'POST', { authorization: `Bearer ${key}` }, JSON.stringify(body), 90000);
  const dir = await ensureDir(config.outputDir || defaultOutputDir());
  return { saved: await saveBytes(fileOf(dir, 'audio', format), buffer), format, voice };
}

async function audio_dashscope(ctx, config, route, text, opts) {
  const key = await resolveKey(ctx, route.entry);
  const format = String((opts && opts.format) || 'mp3');
  const voice = String((opts && opts.voice) || route.entry.voice || config.voice || 'longanlingxin');
  const sampleRate = Number((opts && opts.sampleRate) || 22050);
  const body = mergeExtra({ model: route.model, input: { text, voice, format, sample_rate: sampleRate } }, opts.extra);
  const data = await postJson(`${route.entry.host}/api/v1/services/audio/tts/SpeechSynthesizer`, { authorization: `Bearer ${key}` }, body, 90000);
  const audioUrl = ((data.output || {}).audio || {}).url;
  if (!audioUrl) throw new Error(`接口没有返回音频：${JSON.stringify(data).slice(0, 300)}`);
  const dir = await ensureDir(config.outputDir || defaultOutputDir());
  return { saved: await download(audioUrl, fileOf(dir, 'audio', format), 60000), format, voice };
}

async function audio_elevenlabs(ctx, config, route, text, opts) {
  const key = await resolveKey(ctx, route.entry);
  const voice = String((opts && opts.voice) || route.entry.voice || config.voice || '21m00Tcm4TlvDq8ikWAM');
  const model = route.model || route.entry.audioModel || 'eleven_multilingual_v2';
  const format = String((opts && opts.format) || 'mp3');
  const body = mergeExtra({ text, model_id: model }, opts.extra);
  const { buffer } = await request(
    `${route.entry.host}/v1/text-to-speech/${encodeURIComponent(voice)}`,
    'POST',
    { 'xi-api-key': key },
    JSON.stringify(body),
    90000,
  );
  const dir = await ensureDir(config.outputDir || defaultOutputDir());
  return { saved: await saveBytes(fileOf(dir, 'audio', format), buffer), format, voice };
}

async function audio_google(ctx, config, route, text, opts) {
  const key = await resolveKey(ctx, route.entry);
  const model = route.model || route.entry.audioModel || 'gemini-2.5-flash-preview-tts';
  const voice = String((opts && opts.voice) || route.entry.voice || config.voice || 'Kore');
  const body = mergeExtra(
    {
      contents: [{ parts: [{ text }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
    },
    opts.extra,
  );
  const data = await postJson(
    `${route.entry.host}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
    {},
    body,
    120000,
  );
  const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  const inline = parts.find((part) => part && part.inlineData && part.inlineData.data);
  if (!inline) throw new Error(`接口没有返回音频：${JSON.stringify(data).slice(0, 300)}`);
  const dir = await ensureDir(config.outputDir || defaultOutputDir());
  const mime = inline.inlineData.mimeType || '';
  const raw = decodeBase64(inline.inlineData.data);
  const rateMatch = /rate=(\d+)/.exec(mime);
  const sampleRate = rateMatch ? Number(rateMatch[1]) : 24000;
  // Gemini TTS 返回裸 PCM（audio/L16），必须包 WAV 头才可播放
  const saved = mime.includes('wav') ? await saveBytes(fileOf(dir, 'audio', 'wav'), raw) : await saveBytes(fileOf(dir, 'audio', 'wav'), pcmToWav(raw, sampleRate));
  return { saved, format: 'wav', voice };
}

async function audio_replicate(ctx, config, route, text, opts) {
  return replicateRun(ctx, config, route, mergeExtra({ text }, opts.extra), 'mp3', 240000);
}

/* ------------------------------ 通用 runner ------------------------------ */

/** fal 队列：提交 → 轮询状态 → 取结果。pick(data) 从结果里取资源 URL。 */
async function falRun(ctx, config, route, model, body, pick, ext, timeoutMs) {
  const key = await resolveKey(ctx, route.entry);
  const base = route.entry.host.replace(/\/+$/, '');
  const submit = await postJson(`${base}/${model}`, { authorization: `Key ${key}` }, body, 60000);
  const requestId = submit.request_id || submit.requestId;
  if (!requestId) throw new Error(`提交失败：${JSON.stringify(submit).slice(0, 300)}`);
  const statusUrl = submit.status_url || `${base}/${model}/requests/${requestId}/status`;
  const responseUrl = submit.response_url || `${base}/${model}/requests/${requestId}`;
  const final = await pollUntil(
    () => getJson(statusUrl, { authorization: `Key ${key}` }, 30000),
    (value) => {
      const status = String(value.status || '').toUpperCase();
      if (status === 'FAILED' || status === 'ERROR') throw new Error(`任务失败：${JSON.stringify(value).slice(0, 400)}`);
      return status === 'COMPLETED';
    },
    timeoutMs - 60000,
  );
  const result = await getJson(final.response_url || responseUrl, { authorization: `Key ${key}` }, 60000);
  const url = pick(result);
  if (!url) throw new Error(`任务完成但没有资源 URL：${JSON.stringify(result).slice(0, 300)}`);
  const dir = await ensureDir(config.outputDir || defaultOutputDir());
  return { saved: await download(url, fileOf(dir, ext === 'mp4' ? 'video' : 'image', ext), 180000), taskId: requestId };
}

/** replicate：新建 prediction → 轮询 → 取输出 URL。model 支持 "owner/name" 或 "owner/name:version"。 */
async function replicateRun(ctx, config, route, input, ext, timeoutMs) {
  const key = await resolveKey(ctx, route.entry);
  const host = route.entry.host.replace(/\/+$/, '');
  const modelRef = route.model || '';
  const body = { input };
  if (modelRef.includes(':')) {
    const idx = modelRef.lastIndexOf(':');
    body.version = modelRef.slice(idx + 1);
  } else if (modelRef.includes('/')) {
    body.model = modelRef;
  } else if (modelRef) {
    body.version = modelRef;
  } else {
    throw new Error('replicate 需要 model（owner/name 或 owner/name:version）');
  }
  const created = await postJson(`${host}/v1/predictions`, { authorization: `Token ${key}` }, body, 60000);
  const id = created.id;
  if (!id) throw new Error(`提交失败：${JSON.stringify(created).slice(0, 300)}`);
  const final = await pollUntil(
    () => getJson(`${host}/v1/predictions/${encodeURIComponent(id)}`, { authorization: `Token ${key}` }, 30000),
    (value) => {
      if (value.status === 'failed' || value.status === 'canceled') throw new Error(`任务失败：${JSON.stringify(value).slice(0, 400)}`);
      return value.status === 'succeeded';
    },
    timeoutMs,
  );
  const output = final.output;
  const url = Array.isArray(output) ? output[0] : typeof output === 'string' ? output : output && (output.url || output.video || output.image);
  if (!url) throw new Error(`任务完成但没有输出 URL：${JSON.stringify(final).slice(0, 300)}`);
  const dir = await ensureDir(config.outputDir || defaultOutputDir());
  return { saved: await download(url, fileOf(dir, ext === 'mp4' ? 'video' : ext === 'mp3' ? 'audio' : 'image', ext), 180000), taskId: id };
}

/* ------------------------------ 适配器注册 ------------------------------ */

const ADAPTERS = {
  openai: { image: image_openai, audio: audio_openai },
  dashscope: { image: image_dashscope, video: video_dashscope, audio: audio_dashscope },
  ark: { image: image_ark, video: video_ark },
  zhipu: { image: image_zhipu, video: video_zhipu },
  fal: { image: image_fal, video: video_fal },
  stability: { image: image_stability },
  elevenlabs: { audio: audio_elevenlabs },
  google: { image: image_google, video: video_google, audio: audio_google },
  replicate: { image: image_replicate, video: video_replicate, audio: audio_replicate },
};

const DEFAULT_IMAGE_MODEL = { openai: 'gpt-image-1', dashscope: 'wan2.7-image', zhipu: 'cogview-4', google: 'imagen-4.0-generate-001' };
const DEFAULT_VIDEO_MODEL = { dashscope: 'wan3.0-video', zhipu: 'cogvideox-3', google: 'veo-3.1-generate-preview' };
const DEFAULT_AUDIO_MODEL = { openai: 'tts-1', dashscope: 'qwen-audio-3.0-tts-plus', elevenlabs: 'eleven_multilingual_v2', google: 'gemini-2.5-flash-preview-tts' };

export function createMediaTools(ctx, options = {}) {
  const config = options || {};
  const table = providerTable(config);
  const configured = Object.keys(table).filter((id) => id !== '__default');
  const routeHint = configured.length ? `已配置 provider：${configured.join(', ')}；model 用 "provider/model"。` : '';

  async function run(kindOf, route, extra) {
    const adapter = ADAPTERS[route.entry.kind];
    const fn = adapter && adapter[kindOf];
    if (!fn) throw new Error(`provider "${route.providerId}"（kind=${route.entry.kind}）不支持${kindOf}`);
    return fn(ctx, config, route, ...extra);
  }

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
          lines.push(`· ${provider.id}  ${provider.callable ? '✓ 可调用' : '× 未配置生成端点'}${provider.kind ? '  (' + provider.kind + ')' : ''}`);
          for (const model of provider.models) lines.push(`  - [${model.kind}] ${model.id}`);
        }
        lines.push('', value.note);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    timeoutMs: 15000,
    async execute() {
      const llm = serviceOf(ctx, 'llm');
      const providers = (llm && llm.listProviders ? llm.listProviders() : []);
      const out = [];
      for (const provider of providers) {
        let models = [];
        try {
          models = await llm.listModels(provider.id);
        } catch {
          models = [];
        }
        const media = models
          .map((model) => ({ id: model.id, name: model.name, kind: mediaKindOf(model.id, model.name) }))
          .filter((model) => model.kind !== 'chat');
        if (media.length === 0) continue;
        const entry = table[provider.id];
        const row = { id: provider.id, callable: Boolean(entry), models: media };
        if (entry && entry.kind) row.kind = entry.kind;
        out.push(row);
      }
      return {
        providers: out,
        note:
          '要让某个 provider 的生成模型可调用，在 media 插件 config.providers.<id> 里写 host + kind + apiKeyEnv（或 apiKey）。' +
          ' 调用时 model 传 "provider/model"；工具参数 extra 会合并进请求体。',
      };
    },
  };

  const imageTool = {
    name: 'image_generate',
    description: `用生图模型生成一张图片，保存到本地并返回文件路径（GUI 里会直接显示图片）。` +
      '如果当前会话模型不支持图片输入，不要用 read_image 去验证生成结果（会报 "does not declare image input"），' +
      '图片本身会直接显示。' +
      routeHint,
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '图片描述（中文/英文均可）' },
        model: { type: 'string', description: '可选，"provider/model"（如 ark/doubao-seedream-5-0、openai/gpt-image-1）' },
        extra: { type: 'object', description: '可选，原样合并进请求体（模型私有参数，如 size、steps）' },
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
    timeoutMs: 300000,
    async execute(args) {
      const prompt = String((args && args.prompt) || '').trim();
      if (!prompt) throw new Error('prompt 必填');
      const route = pickRoute(config, args && args.model, 'image');
      if (!ADAPTERS[route.entry.kind] || !ADAPTERS[route.entry.kind].image) {
        throw new Error(`provider "${route.providerId}"（kind=${route.entry.kind}）不支持图片生成`);
      }
      route.model = route.model || route.entry.imageModel || config.imageModel || DEFAULT_IMAGE_MODEL[route.entry.kind];
      if (!route.model) throw new Error(`provider "${route.providerId}" 需要 image model`);
      const saved = await withProxy(route.entry, config, () => run('image', route, [prompt, { extra: args.extra }]));
      const bytes = await readFile(saved.file);
      const ext = saved.file.split('.').pop();
      const mediaType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
      const block = await imageBlock(ctx, bytes, mediaType);
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
        model: { type: 'string', description: '可选，"provider/model"' },
        duration: { type: 'number', description: '秒数（默认 3；越长越贵）' },
        resolution: { type: 'string', description: '480P / 720P / 1080P（默认 480P，dashscope 生效）' },
        ratio: { type: 'string', description: '比例，默认 adaptive（dashscope 生效）' },
        imageUrl: { type: 'string', description: '可选：首帧图片 URL（图生视频）' },
        extra: { type: 'object', description: '可选，原样合并进请求体（模型私有参数）' },
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
    timeoutMs: 600000,
    async execute(args) {
      const prompt = String((args && args.prompt) || '').trim();
      if (!prompt) throw new Error('prompt 必填');
      const route = pickRoute(config, args && args.model, 'video');
      if (!ADAPTERS[route.entry.kind] || !ADAPTERS[route.entry.kind].video) {
        throw new Error(`provider "${route.providerId}"（kind=${route.entry.kind}）不支持视频生成`);
      }
      route.model = route.model || route.entry.videoModel || config.videoModel || DEFAULT_VIDEO_MODEL[route.entry.kind];
      if (!route.model) throw new Error(`provider "${route.providerId}" 需要 video model`);
      const result = await withProxy(route.entry, config, () => run('video', route, [prompt, args || {}]));
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
        model: { type: 'string', description: '可选，"provider/model"' },
        voice: { type: 'string', description: '音色，覆盖默认值' },
        format: { type: 'string', description: 'mp3 / pcm / wav / opus，默认 mp3' },
        sampleRate: { type: 'number', description: '采样率，默认 22050（dashscope 生效）' },
        extra: { type: 'object', description: '可选，原样合并进请求体（模型私有参数）' },
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
    timeoutMs: 180000,
    async execute(args) {
      const text = String((args && args.text) || '').trim();
      if (!text) throw new Error('text 必填');
      const route = pickRoute(config, args && args.model, 'audio');
      if (!ADAPTERS[route.entry.kind] || !ADAPTERS[route.entry.kind].audio) {
        throw new Error(`provider "${route.providerId}"（kind=${route.entry.kind}）不支持音频生成`);
      }
      route.model = route.model || route.entry.audioModel || config.audioModel || DEFAULT_AUDIO_MODEL[route.entry.kind];
      if (!route.model) throw new Error(`provider "${route.providerId}" 需要 audio model`);
      const result = await withProxy(route.entry, config, () => run('audio', route, [text, args || {}]));
      const mediaType = result.format === 'wav' ? 'audio/wav' : result.format === 'opus' ? 'audio/opus' : 'audio/mpeg';
      const block = await fileBlock(ctx, result.saved.file, mediaType);
      return { ok: true, kind: 'audio', provider: route.providerId, model: route.model, voice: result.voice, format: result.format, file: result.saved.file, bytes: result.saved.bytes, block };
    },
  };

  return { models: modelsTool, image: imageTool, video: videoTool, audio: audioTool };
}

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
export const inject = ['tools'];
export { mediaKindOf, providerTable, ADAPTERS };
