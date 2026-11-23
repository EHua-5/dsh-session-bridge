/**
 * 生成类工具：图片 / 视频 / 音频。
 *
 * 这条链路和"换模型"无关——生图/生视频/合成语音的接口形状和 agent 对话不同，
 * 所以用专门的工具按各自 API 调用，结果落到本地文件，并把图片作为内容块返回（GUI 里直接显示）。
 *
 * 端点（Token Plan，阿里云百炼）：
 *  - 图：POST {host}/compatible-mode/v1/chat/completions
 *        body: { model, messages: [{ role: 'user', content: [{ type: 'text', text }] }] }
 *        → output.choices[0].message.content[].image（URL）
 *  - 视频：POST {host}/api/v1/services/aigc/video-generation/video-synthesis（X-DashScope-Async: enable）
 *        body: { model, input: { prompt }, parameters: { resolution, ratio, duration, prompt_extend } }
 *        → output.task_id；轮询 GET {host}/api/v1/tasks/{id} → output.video_url
 *  - 音频：POST {host}/api/v1/services/audio/tts/SpeechSynthesizer
 *        body: { model, input: { text, voice, format, sample_rate } }
 *        → output.audio.url
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, extname } from 'node:path';

const DEFAULT_HOST = 'https://token-plan.cn-beijing.maas.aliyuncs.com';
const DEFAULT_IMAGE_MODEL = 'wan2.7-image';
const DEFAULT_VIDEO_MODEL = 'wan3.0-video';
const DEFAULT_AUDIO_MODEL = 'qwen-audio-3.0-tts-plus';
const DEFAULT_VOICE = 'longanlingxin';

function defaultOutputDir() {
  return join(homedir(), '.dsh', 'generated');
}

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
  return dir;
}

async function resolveKey(ctx, config) {
  const envName = (config && config.apiKeyEnv) || 'BAILIAN_TPP_API_KEY';
  if (config && config.apiKey) return String(config.apiKey);
  if (envName && process.env[envName]) return process.env[envName];
  const credentials = ctx && ctx.credentials;
  if (envName && credentials && typeof credentials.resolve === 'function') {
    const resolved = await credentials.resolve(envName);
    if (resolved && resolved.value) return resolved.value;
  }
  throw new Error(`找不到 ${envName}：可在 profile 的插件 config 里配置 apiKey，或把它放进环境变量/凭据库`);
}

function baseUrl(config) {
  return String((config && config.host) || DEFAULT_HOST).replace(/\/+$/, '');
}

async function postJson(url, headers, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, headers, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
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

function stamp() {
  const now = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-` +
    `${pad(now.getMilliseconds(), 3)}`
  );
}

function fileOf(dir, kind, ext) {
  return join(dir, `${kind}-${stamp()}.${ext}`);
}

/** 把图片字节交给附件服务，返回可以直接进消息的 image block；不可用则返回 null。 */
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

export function createMediaTools(ctx, options = {}) {
  const config = options || {};
  const outputDir = (config.outputDir && String(config.outputDir)) || defaultOutputDir();

  const imageTool = {
    name: 'image_generate',
    description:
      '用生图模型生成一张图片，保存到本地并返回文件路径（GUI 里会直接显示图片）。' +
      'prompt 用具体描述：主体、风格、构图、光线；默认模型 wan2.7-image。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '图片描述（中文/英文均可）' },
        model: { type: 'string', description: '可选，默认 wan2.7-image' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => {
      const blocks = [textBlock(`图片已生成：${value.file}（${value.bytes} 字节）`)];
      if (value.block) blocks.push(value.block);
      else blocks.push(textBlock(`![${value.prompt}](${value.file})`));
      return blocks;
    } },
    timeoutMs: 180000,
    async execute(args) {
      const prompt = String((args && args.prompt) || '').trim();
      if (!prompt) throw new Error('prompt 必填');
      const model = String((args && args.model) || config.imageModel || DEFAULT_IMAGE_MODEL);
      const key = await resolveKey(ctx, config);
      const body = { model, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] };
      const data = await postJson(`${baseUrl(config)}/compatible-mode/v1/chat/completions`, { authorization: `Bearer ${key}` }, body, 150000);
      const content = (((data.output || {}).choices || [])[0] || {}).message?.content || [];
      const entry = (Array.isArray(content) ? content : []).find((part) => part && part.type === 'image' && part.image);
      if (!entry) throw new Error(`接口没有返回图片：${JSON.stringify(data).slice(0, 300)}`);
      const dir = await ensureDir(outputDir);
      const saved = await download(entry.image, fileOf(dir, 'image', 'png'), 120000);
      const bytes = await readFile(saved.file);
      const block = await imageBlock(ctx, bytes, 'image/png');
      return { ok: true, kind: 'image', model, prompt, file: saved.file, bytes: saved.bytes, block, sourceUrl: entry.image };
    },
  };

  const videoTool = {
    name: 'video_generate',
    description:
      '用视频模型生成短视频（异步任务：提交后轮询，通常 1–5 分钟），保存到本地并返回文件路径。' +
      '默认模型 wan3.0-video；可用 imageUrl 传首帧图片做图生视频。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '视频描述' },
        model: { type: 'string', description: '可选，默认 wan3.0-video' },
        duration: { type: 'number', description: '秒数（默认 3；越长越贵）' },
        resolution: { type: 'string', description: '480P / 720P / 1080P（默认 480P）' },
        ratio: { type: 'string', description: '比例，默认 adaptive' },
        imageUrl: { type: 'string', description: '可选：首帧图片 URL（图生视频）' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => {
      const blocks = [textBlock(`视频已生成：${value.file}（${value.bytes} 字节，${value.duration}s ${value.resolution}）`)];
      if (value.block) blocks.push(value.block);
      return blocks;
    } },
    timeoutMs: 420000,
    async execute(args) {
      const prompt = String((args && args.prompt) || '').trim();
      if (!prompt) throw new Error('prompt 必填');
      const model = String((args && args.model) || config.videoModel || DEFAULT_VIDEO_MODEL);
      const duration = Number((args && args.duration) || 3);
      const resolution = String((args && args.resolution) || '480P');
      const ratio = String((args && args.ratio) || 'adaptive');
      const key = await resolveKey(ctx, config);
      const host = baseUrl(config);
      const input = { prompt };
      if (args && args.imageUrl) input.media = [{ type: 'first_frame', url: String(args.imageUrl) }];
      const submit = await postJson(
        `${host}/api/v1/services/aigc/video-generation/video-synthesis`,
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
        const status = await getJson(`${host}/api/v1/tasks/${encodeURIComponent(taskId)}`, { authorization: `Bearer ${key}` }, 30000);
        const out = status.output || {};
        if (out.task_status === 'SUCCEEDED') {
          videoUrl = out.video_url || '';
          if (!videoUrl) throw new Error(`任务成功但没有 video_url：${JSON.stringify(status).slice(0, 300)}`);
          break;
        }
        if (out.task_status === 'FAILED' || out.task_status === 'CANCELED') {
          throw new Error(`任务 ${out.task_status}：${JSON.stringify(out).slice(0, 400)}`);
        }
      }
      if (!videoUrl) throw new Error(`任务超时（task_id=${taskId}）`);
      const dir = await ensureDir(outputDir);
      const saved = await download(videoUrl, fileOf(dir, 'video', 'mp4'), 180000);
      const block = await fileBlock(ctx, saved.file, 'video/mp4');
      return { ok: true, kind: 'video', model, prompt, duration, resolution, file: saved.file, bytes: saved.bytes, block, taskId };
    },
  };

  const audioTool = {
    name: 'audio_generate',
    description:
      '用语音合成模型把文本转成音频（默认 mp3），保存到本地并返回文件路径。' +
      '默认模型 qwen-audio-3.0-tts-plus、音色 longanlingxin（中文/英文）；也可传 voice 换音色。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要合成的文本' },
        voice: { type: 'string', description: '音色，默认 longanlingxin（女）；男声可用 longanlufeng' },
        format: { type: 'string', description: 'mp3 / pcm / wav / opus，默认 mp3' },
        model: { type: 'string', description: '可选，默认 qwen-audio-3.0-tts-plus' },
        sampleRate: { type: 'number', description: '采样率，默认 22050' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => {
      const blocks = [textBlock(`音频已生成：${value.file}（${value.bytes} 字节，${value.format}）`)];
      if (value.block) blocks.push(value.block);
      return blocks;
    } },
    timeoutMs: 120000,
    async execute(args) {
      const text = String((args && args.text) || '').trim();
      if (!text) throw new Error('text 必填');
      const model = String((args && args.model) || config.audioModel || DEFAULT_AUDIO_MODEL);
      const voice = String((args && args.voice) || config.voice || DEFAULT_VOICE);
      const format = String((args && args.format) || 'mp3');
      const sampleRate = Number((args && args.sampleRate) || 22050);
      const key = await resolveKey(ctx, config);
      const host = baseUrl(config);
      const data = await postJson(
        `${host}/api/v1/services/audio/tts/SpeechSynthesizer`,
        { authorization: `Bearer ${key}` },
        { model, input: { text, voice, format, sample_rate: sampleRate } },
        90000,
      );
      const audioUrl = ((data.output || {}).audio || {}).url;
      if (!audioUrl) throw new Error(`接口没有返回音频：${JSON.stringify(data).slice(0, 300)}`);
      const dir = await ensureDir(outputDir);
      const saved = await download(audioUrl, fileOf(dir, 'audio', format === 'pcm' ? 'pcm' : format), 60000);
      const mediaType = format === 'wav' ? 'audio/wav' : format === 'opus' ? 'audio/opus' : 'audio/mpeg';
      const block = await fileBlock(ctx, saved.file, mediaType);
      return { ok: true, kind: 'audio', model, voice, format, file: saved.file, bytes: saved.bytes, block };
    },
  };

  return { image: imageTool, video: videoTool, audio: audioTool };
}

/** 注册三个工具；返回 disposer。 */
export function apply(ctx, config) {
  const tools = createMediaTools(ctx, config);
  const disposers = [ctx.tools.register(tools.image), ctx.tools.register(tools.video), ctx.tools.register(tools.audio)];
  return () => {
    for (const dispose of disposers) dispose();
  };
}

export const name = 'media';
export const inject = ['tools'];
export { DEFAULT_HOST, DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL, DEFAULT_AUDIO_MODEL, DEFAULT_VOICE };
