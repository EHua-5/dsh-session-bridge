import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createMediaTools } from '../media.js';

const KEY = 'sk-test';

function ctxWith({ attachments } = {}) {
  return {
    credentials: { resolve: async (ref) => (ref === 'BAILIAN_TPP_API_KEY' ? { value: KEY, source: 'file' } : undefined) },
    attachments,
  };
}

/** 拦截 fetch，按 URL 匹配返回预置响应。 */
function stubFetch(routes) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    calls.push({ url: href, init });
    const route = routes.find((r) => (typeof r.match === 'function' ? r.match(href, init) : href.includes(r.match)));
    if (!route) throw new Error(`unexpected fetch: ${href}`);
    return route.reply(href, init);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function jsonReply(body) {
  return () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function bytesReply(bytes, type = 'application/octet-stream') {
  return () => new Response(bytes, { status: 200, headers: { 'content-type': type } });
}

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-media-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('image：解析 output…image 并落盘', async () => {
  await withDir(async (dir) => {
    const tools = createMediaTools(ctxWith(), { outputDir: dir });
    const stub = stubFetch([
      { match: '/compatible-mode/v1/chat/completions', reply: jsonReply({ output: { choices: [{ message: { content: [{ type: 'image', image: 'https://cdn.example/a.png' }] } }] } }) },
      { match: 'cdn.example/a.png', reply: bytesReply(new Uint8Array([1, 2, 3]), 'image/png') },
    ]);
    try {
      const value = await tools.image.execute({ prompt: '一只狐狸' });
      assert.equal(value.ok, true);
      assert.equal(value.kind, 'image');
      assert.match(value.file, /image-.*\.png$/);
      assert.equal(value.bytes, 3);
      assert.equal(value.block, null, '没有附件服务时返回 null，由 render 用 markdown');
      const blocks = tools.image.output.render({}, value);
      const text = blocks.map((b) => b.text || '').join('\n');
      assert.match(text, /!\[一只狐狸\]/);
      // 请求体：user-only + content 数组
      const body = JSON.parse(stub.calls[0].init.body);
      assert.equal(body.messages[0].role, 'user');
      assert.deepEqual(body.messages[0].content, [{ type: 'text', text: '一只狐狸' }]);
    } finally {
      stub.restore();
    }
  });
});

test('image：接口没图时报错', async () => {
  const tools = createMediaTools(ctxWith(), { outputDir: 'x' });
  const stub = stubFetch([{ match: '/chat/completions', reply: jsonReply({ output: { choices: [{ message: { content: [] } }] } }) }]);
  try {
    await assert.rejects(() => tools.image.execute({ prompt: 'x' }), /图片接口没有返回结果/);
  } finally {
    stub.restore();
  }
});

test('video：提交 → 轮询 → 下载', async () => {
  await withDir(async (dir) => {
    const tools = createMediaTools(ctxWith(), { outputDir: dir });
    let polls = 0;
    const stub = stubFetch([
      { match: '/api/v1/services/aigc/video-generation/video-synthesis', reply: jsonReply({ output: { task_id: 't1', task_status: 'PENDING' } }) },
      { match: '/api/v1/tasks/t1', reply: () => {
        polls += 1;
        return jsonReply(polls < 2 ? { output: { task_status: 'RUNNING' } } : { output: { task_status: 'SUCCEEDED', video_url: 'https://cdn.example/v.mp4' } })();
      } },
      { match: 'cdn.example/v.mp4', reply: bytesReply(new Uint8Array([9, 9, 9, 9]), 'video/mp4') },
    ]);
    try {
      const value = await tools.video.execute({ prompt: '狐狸跑过', duration: 2, resolution: '480P' });
      assert.equal(value.ok, true);
      assert.equal(value.taskId, 't1');
      assert.equal(value.bytes, 4);
      const submitBody = JSON.parse(stub.calls[0].init.body);
      assert.equal(submitBody.input.prompt, '狐狸跑过');
      assert.equal(submitBody.parameters.duration, 2);
      assert.equal(submitBody.parameters.resolution, '480P');
      assert.equal(stub.calls[0].init.headers['x-dashscope-async'], 'enable');
    } finally {
      stub.restore();
    }
  });
});

test('video：任务 FAILED 时报错', async () => {
  const tools = createMediaTools(ctxWith(), { outputDir: 'x' });
  const stub = stubFetch([
    { match: 'video-synthesis', reply: jsonReply({ output: { task_id: 't2' } }) },
    { match: '/api/v1/tasks/t2', reply: jsonReply({ output: { task_status: 'FAILED', message: 'boom' } }) },
  ]);
  try {
    await assert.rejects(() => tools.video.execute({ prompt: 'x' }), /FAILED/);
  } finally {
    stub.restore();
  }
});

test('audio：TTS 返回 URL 并落盘；默认音色/格式', async () => {
  await withDir(async (dir) => {
    const tools = createMediaTools(ctxWith(), { outputDir: dir });
    const stub = stubFetch([
      { match: '/api/v1/services/audio/tts/SpeechSynthesizer', reply: jsonReply({ output: { audio: { url: 'https://cdn.example/a.mp3' } } }) },
      { match: 'cdn.example/a.mp3', reply: bytesReply(new Uint8Array([7, 7]), 'audio/mpeg') },
    ]);
    try {
      const value = await tools.audio.execute({ text: '你好' });
      assert.equal(value.ok, true);
      assert.equal(value.voice, 'longanlingxin');
      assert.equal(value.format, 'mp3');
      assert.match(value.file, /audio-.*\.mp3$/);
      const body = JSON.parse(stub.calls[0].init.body);
      assert.equal(body.input.voice, 'longanlingxin');
      assert.equal(body.input.format, 'mp3');
    } finally {
      stub.restore();
    }
  });
});

test('key：拿不到凭据时明确报错', async () => {
  const tools = createMediaTools({ credentials: { resolve: async () => undefined } }, { outputDir: 'x' });
  await assert.rejects(() => tools.image.execute({ prompt: 'x' }), /找不到 BAILIAN_TPP_API_KEY/);
});

test('附件服务可用时返回 image block', async () => {
  await withDir(async (dir) => {
    const ref = { id: 'img-1' };
    const ctx = ctxWith({
      attachments: {
        saveImages: async (inputs) => {
          assert.equal(inputs.length, 1);
          assert.equal(inputs[0].mediaType, 'image/png');
          return [ref];
        },
      },
    });
    const tools = createMediaTools(ctx, { outputDir: dir });
    const stub = stubFetch([
      { match: '/chat/completions', reply: jsonReply({ output: { choices: [{ message: { content: [{ type: 'image', image: 'https://cdn.example/b.png' }] } }] } }) },
      { match: 'cdn.example/b.png', reply: bytesReply(new Uint8Array([5]), 'image/png') },
    ]);
    try {
      const value = await tools.image.execute({ prompt: 'x' });
      assert.deepEqual(value.block, { type: 'image', attachment: ref });
      const blocks = tools.image.output.render({}, value);
      assert.equal(blocks.length, 2);
      assert.equal(blocks[1].type, 'image');
    } finally {
      stub.restore();
    }
  });
});

test('openai 图片：/v1/images/generations + b64_json', async () => {
  await withDir(async (dir) => {
    const tools = createMediaTools(ctxWith(), { outputDir: dir, provider: 'openai', apiKeyEnv: 'BAILIAN_TPP_API_KEY' });
    const b64 = Buffer.from([1, 2, 3, 4]).toString('base64');
    const stub = stubFetch([
      { match: '/v1/images/generations', reply: jsonReply({ data: [{ b64_json: b64 }] }) },
    ]);
    try {
      const value = await tools.image.execute({ prompt: '一只猫' });
      assert.equal(value.ok, true);
      assert.equal(value.provider, 'openai');
      assert.equal(value.model, 'gpt-image-1');
      assert.equal(value.bytes, 4);
      const body = JSON.parse(stub.calls[0].init.body);
      assert.equal(body.prompt, '一只猫');
      assert.equal(body.response_format, 'b64_json');
    } finally {
      stub.restore();
    }
  });
});

test('openai 图片：没有 b64_json 时回退下载 url', async () => {
  await withDir(async (dir) => {
    const tools = createMediaTools(ctxWith(), { outputDir: dir, provider: 'openai' });
    const stub = stubFetch([
      { match: '/v1/images/generations', reply: jsonReply({ data: [{ url: 'https://cdn.example/o.png' }] }) },
      { match: 'cdn.example/o.png', reply: bytesReply(new Uint8Array([9, 9]), 'image/png') },
    ]);
    try {
      const value = await tools.image.execute({ prompt: 'x' });
      assert.equal(value.bytes, 2);
    } finally {
      stub.restore();
    }
  });
});

test('openai 音频：/v1/audio/speech 返回字节', async () => {
  await withDir(async (dir) => {
    const tools = createMediaTools(ctxWith(), { outputDir: dir, provider: 'openai' });
    const stub = stubFetch([
      { match: '/v1/audio/speech', reply: bytesReply(new Uint8Array([7, 7, 7]), 'audio/mpeg') },
    ]);
    try {
      const value = await tools.audio.execute({ text: '你好' });
      assert.equal(value.ok, true);
      assert.equal(value.provider, 'openai');
      assert.equal(value.model, 'tts-1');
      assert.equal(value.voice, 'alloy');
      assert.equal(value.bytes, 3);
      const body = JSON.parse(stub.calls[0].init.body);
      assert.equal(body.input, '你好');
      assert.equal(body.response_format, 'mp3');
    } finally {
      stub.restore();
    }
  });
});

test('openai provider 下视频明确报错', async () => {
  const tools = createMediaTools(ctxWith(), { outputDir: 'x', provider: 'openai' });
  await assert.rejects(() => tools.video.execute({ prompt: 'x' }), /不支持视频生成/);
});

function ctxWithLlm(providers) {
  return {
    credentials: { resolve: async (ref) => (ref === 'TEST_KEY' ? { value: KEY, source: 'file' } : undefined) },
    llm: {
      listProviders: () => providers.map(([id]) => ({ id, name: id })),
      listModels: async (id) => {
        const entry = providers.find(([pid]) => pid === id);
        return (entry && entry[1]) || [];
      },
    },
  };
}

test('media_models：列出能生成的多模态模型并标出可调用', async () => {
  const ctx = ctxWithLlm([
    ['ark', [{ provider: 'ark', id: 'doubao-seedream-5-0', name: 'Seedream' }, { provider: 'ark', id: 'doubao-seed-2.1-pro', name: 'Seed' }]],
    ['bailian', [{ provider: 'bailian', id: 'wan2.7-image', name: 'Wan' }]],
  ]);
  const tools = createMediaTools(ctx, {
    outputDir: 'x',
    providers: { ark: { kind: 'ark', host: 'https://ark.example', apiKeyEnv: 'TEST_KEY' } },
  });
  const value = await tools.models.execute({});
  const byId = Object.fromEntries(value.providers.map((entry) => [entry.id, entry]));
  assert.deepEqual(byId.ark.models.map((m) => m.id), ['doubao-seedream-5-0']);
  assert.equal(byId.ark.callable, true);
  assert.equal(byId.bailian.callable, false);
  const text = tools.models.output.render({}, value)[0].text;
  assert.match(text, /\[image\] doubao-seedream-5-0/);
  // 未配置的 provider 不能出现 undefined 字段（工具输出要求 lossless JSON）
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
});

test('ark 图片：/api/v3/images/generations + url 下载', async () => {
  await withDir(async (dir) => {
    const tools = createMediaTools(ctxWith(), {
      outputDir: dir,
      providers: { ark: { kind: 'ark', host: 'https://ark.example', apiKeyEnv: 'BAILIAN_TPP_API_KEY' } },
    });
    const stub = stubFetch([
      { match: '/api/v3/images/generations', reply: jsonReply({ data: [{ url: 'https://cdn.example/ark.png' }] }) },
      { match: 'cdn.example/ark.png', reply: bytesReply(new Uint8Array([1, 2, 3]), 'image/png') },
    ]);
    try {
      const value = await tools.image.execute({ prompt: 'seedream', model: 'ark/doubao-seedream-5-0' });
      assert.equal(value.provider, 'ark');
      assert.equal(value.model, 'doubao-seedream-5-0');
      assert.equal(value.bytes, 3);
      const body = JSON.parse(stub.calls[0].init.body);
      assert.equal(body.prompt, 'seedream');
    } finally {
      stub.restore();
    }
  });
});

test('ark 视频：提交任务 + 轮询 + 下载', async () => {
  await withDir(async (dir) => {
    const tools = createMediaTools(ctxWith(), {
      outputDir: dir,
      providers: { ark: { kind: 'ark', host: 'https://ark.example', apiKeyEnv: 'BAILIAN_TPP_API_KEY' } },
    });
    const stub = stubFetch([
      { match: '/api/v3/contents/generations/tasks/cgt-1', reply: jsonReply({ status: 'succeeded', content: { video_url: 'https://cdn.example/ark.mp4' } }) },
      { match: (href, init) => href.endsWith('/api/v3/contents/generations/tasks') && init.method === 'POST', reply: jsonReply({ id: 'cgt-1' }) },
      { match: 'cdn.example/ark.mp4', reply: bytesReply(new Uint8Array([5, 5]), 'video/mp4') },
    ]);
    try {
      const value = await tools.video.execute({ prompt: 'seedance', model: 'ark/doubao-seedance-1-0-pro' });
      assert.equal(value.ok, true);
      assert.equal(value.provider, 'ark');
      assert.equal(value.taskId, 'cgt-1');
      assert.equal(value.bytes, 2);
    } finally {
      stub.restore();
    }
  });
});

function ctxWithKey(ref = 'BAILIAN_TPP_API_KEY') {
  return {
    credentials: { resolve: async (name) => (name === ref ? { value: KEY, source: 'file' } : undefined) },
  };
}

test('zhipu 图片：/api/paas/v4/images/generations', async () => {
  await withDir(async (dir) => {
    const tools = createMediaTools(ctxWith(), {
      outputDir: dir,
      providers: { zhipu: { kind: 'zhipu', host: 'https://open.bigmodel.cn', apiKeyEnv: 'BAILIAN_TPP_API_KEY' } },
    });
    const stub = stubFetch([
      { match: '/api/paas/v4/images/generations', reply: jsonReply({ data: [{ url: 'https://cdn.example/z.png' }] }) },
      { match: 'cdn.example/z.png', reply: bytesReply(new Uint8Array([1, 2]), 'image/png') },
    ]);
    try {
      const value = await tools.image.execute({ prompt: '猫', model: 'zhipu/cogview-4' });
      assert.equal(value.provider, 'zhipu');
      assert.equal(value.bytes, 2);
      const body = JSON.parse(stub.calls[0].init.body);
      assert.equal(body.model, 'cogview-4');
    } finally {
      stub.restore();
    }
  });
});

test('stability 图片：multipart + 二进制', async () => {
  await withDir(async (dir) => {
    const tools = createMediaTools(ctxWith(), {
      outputDir: dir,
      providers: { stability: { kind: 'stability', host: 'https://api.stability.ai', apiKeyEnv: 'BAILIAN_TPP_API_KEY' } },
    });
    const stub = stubFetch([
      { match: '/v2beta/stable-image/generate/core', reply: bytesReply(new Uint8Array([3, 3, 3]), 'image/png') },
    ]);
    try {
      const value = await tools.image.execute({ prompt: '猫', model: 'stability/core' });
      assert.equal(value.bytes, 3);
      const call = stub.calls[0];
      assert.ok(call.init.body instanceof FormData);
      assert.match(call.init.headers.accept, /image/);
    } finally {
      stub.restore();
    }
  });
});

test('elevenlabs 音频：xi-api-key + 二进制', async () => {
  await withDir(async (dir) => {
    const tools = createMediaTools(ctxWith(), {
      outputDir: dir,
      providers: { eleven: { kind: 'elevenlabs', host: 'https://api.elevenlabs.io', apiKeyEnv: 'BAILIAN_TPP_API_KEY', voice: 'voice-1' } },
    });
    const stub = stubFetch([
      { match: (href) => href.includes('/v1/text-to-speech/voice-1'), reply: bytesReply(new Uint8Array([6, 6]), 'audio/mpeg') },
    ]);
    try {
      const value = await tools.audio.execute({ text: '你好', model: 'eleven/eleven_multilingual_v2' });
      assert.equal(value.voice, 'voice-1');
      assert.equal(value.bytes, 2);
      assert.equal(stub.calls[0].init.headers['xi-api-key'], KEY);
    } finally {
      stub.restore();
    }
  });
});

test('google 图片：/v1beta/models/{model}:predict', async () => {
  await withDir(async (dir) => {
    const tools = createMediaTools(ctxWith(), {
      outputDir: dir,
      providers: { google: { kind: 'google', host: 'https://generativelanguage.googleapis.com', apiKeyEnv: 'BAILIAN_TPP_API_KEY' } },
    });
    const b64 = Buffer.from([8, 8]).toString('base64');
    const stub = stubFetch([
      { match: (href) => href.includes(':predict') && !href.includes('LongRunning'), reply: jsonReply({ predictions: [{ bytesBase64Encoded: b64, mimeType: 'image/png' }] }) },
    ]);
    try {
      const value = await tools.image.execute({ prompt: '猫', model: 'google/imagen-4.0-generate-001' });
      assert.equal(value.bytes, 2);
      assert.match(stub.calls[0].url, /key=/);
    } finally {
      stub.restore();
    }
  });
});

test('google 视频：predictLongRunning + 轮询 + 带 key 下载', async () => {
  await withDir(async (dir) => {
    const tools = createMediaTools(ctxWith(), {
      outputDir: dir,
      providers: { google: { kind: 'google', host: 'https://generativelanguage.googleapis.com', apiKeyEnv: 'BAILIAN_TPP_API_KEY' } },
    });
    const stub = stubFetch([
      { match: (href) => href.includes(':predictLongRunning'), reply: jsonReply({ name: 'operations/abc' }) },
      { match: (href) => href.includes('operations/abc'), reply: jsonReply({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://cdn.example/g.mp4' } }] } } }) },
      { match: 'cdn.example/g.mp4', reply: bytesReply(new Uint8Array([4, 4]), 'video/mp4') },
    ]);
    try {
      const value = await tools.video.execute({ prompt: '猫', model: 'google/veo-3.1-generate-preview' });
      assert.equal(value.bytes, 2);
      assert.equal(value.taskId, 'operations/abc');
    } finally {
      stub.restore();
    }
  });
});

test('fal 图片：队列提交 + 状态 + 结果', async () => {
  await withDir(async (dir) => {
    const tools = createMediaTools(ctxWith(), {
      outputDir: dir,
      providers: { fal: { kind: 'fal', host: 'https://queue.fal.run', apiKeyEnv: 'BAILIAN_TPP_API_KEY' } },
    });
    const stub = stubFetch([
      { match: (href, init) => href.endsWith('/fal-ai/flux/schnell') && init.method === 'POST', reply: jsonReply({ request_id: 'r1', status_url: 'https://queue.fal.run/fal-ai/flux/schnell/requests/r1/status', response_url: 'https://queue.fal.run/fal-ai/flux/schnell/requests/r1' }) },
      { match: (href) => href.endsWith('/requests/r1/status'), reply: jsonReply({ status: 'COMPLETED', response_url: 'https://queue.fal.run/fal-ai/flux/schnell/requests/r1' }) },
      { match: (href, init) => href.endsWith('/requests/r1') && init.method === 'GET', reply: jsonReply({ images: [{ url: 'https://cdn.example/f.png' }] }) },
      { match: 'cdn.example/f.png', reply: bytesReply(new Uint8Array([7]), 'image/png') },
    ]);
    try {
      const value = await tools.image.execute({ prompt: '猫', model: 'fal/fal-ai/flux/schnell' });
      assert.equal(value.bytes, 1);
      assert.equal(value.provider, 'fal');
    } finally {
      stub.restore();
    }
  });
});

test('replicate 图片：predictions + 轮询 + 输出 URL', async () => {
  await withDir(async (dir) => {
    const tools = createMediaTools(ctxWith(), {
      outputDir: dir,
      providers: { replicate: { kind: 'replicate', host: 'https://api.replicate.com', apiKeyEnv: 'BAILIAN_TPP_API_KEY' } },
    });
    const stub = stubFetch([
      { match: (href, init) => href.endsWith('/v1/predictions') && init.method === 'POST', reply: jsonReply({ id: 'p1' }) },
      { match: (href) => href.endsWith('/v1/predictions/p1'), reply: jsonReply({ status: 'succeeded', output: ['https://cdn.example/r.png'] }) },
      { match: 'cdn.example/r.png', reply: bytesReply(new Uint8Array([2, 2]), 'image/png') },
    ]);
    try {
      const value = await tools.image.execute({ prompt: '猫', model: 'replicate/black-forest-labs/flux-schnell:abc123' });
      assert.equal(value.bytes, 2);
      const body = JSON.parse(stub.calls[0].init.body);
      assert.equal(body.version, 'abc123');
      assert.equal(body.input.prompt, '猫');
    } finally {
      stub.restore();
    }
  });
});

test('zhipu 视频：提交 + async-result', async () => {
  await withDir(async (dir) => {
    const tools = createMediaTools(ctxWith(), {
      outputDir: dir,
      providers: { zhipu: { kind: 'zhipu', host: 'https://open.bigmodel.cn', apiKeyEnv: 'BAILIAN_TPP_API_KEY' } },
    });
    const stub = stubFetch([
      { match: '/api/paas/v4/videos/generations', reply: jsonReply({ id: 'v1' }) },
      { match: (href) => href.includes('/api/paas/v4/async-result/v1'), reply: jsonReply({ task_status: 'SUCCESS', video_result: [{ url: 'https://cdn.example/z.mp4' }] }) },
      { match: 'cdn.example/z.mp4', reply: bytesReply(new Uint8Array([9, 9, 9]), 'video/mp4') },
    ]);
    try {
      const value = await tools.video.execute({ prompt: '猫', model: 'zhipu/cogvideox-3' });
      assert.equal(value.taskId, 'v1');
      assert.equal(value.bytes, 3);
    } finally {
      stub.restore();
    }
  });
});

test('google gemini 图片：generateContent + inlineData', async () => {
  await withDir(async (dir) => {
    const tools = createMediaTools(ctxWith(), {
      outputDir: dir,
      providers: { google: { kind: 'google', host: 'https://generativelanguage.googleapis.com', apiKeyEnv: 'BAILIAN_TPP_API_KEY' } },
    });
    const b64 = Buffer.from([4, 4]).toString('base64');
    const stub = stubFetch([
      { match: (href) => href.includes(':generateContent'), reply: jsonReply({ candidates: [{ content: { parts: [{ inlineData: { data: b64, mimeType: 'image/png' } }] } }] }) },
    ]);
    try {
      const value = await tools.image.execute({ prompt: '猫', model: 'google/gemini-3.1-flash-lite-image' });
      assert.equal(value.bytes, 2);
      assert.match(value.file, /\.png$/);
      const body = JSON.parse(stub.calls[0].init.body);
      assert.deepEqual(body.generationConfig.responseModalities, ['TEXT', 'IMAGE']);
    } finally {
      stub.restore();
    }
  });
});

test('多 provider 不写 model 时按能力自动挑（audio → dashscope）', async () => {
  await withDir(async (dir) => {
    const tools = createMediaTools(ctxWith(), {
      outputDir: dir,
      providers: {
        ark: { kind: 'ark', host: 'https://ark.example', apiKeyEnv: 'BAILIAN_TPP_API_KEY' },
        bailian: { kind: 'dashscope', host: 'https://dash.example', apiKeyEnv: 'BAILIAN_TPP_API_KEY' },
      },
    });
    const stub = stubFetch([
      { match: '/api/v1/services/audio/tts/SpeechSynthesizer', reply: jsonReply({ output: { audio: { url: 'https://cdn.example/a.mp3' } } }) },
      { match: 'cdn.example/a.mp3', reply: bytesReply(new Uint8Array([1]), 'audio/mpeg') },
    ]);
    try {
      const value = await tools.audio.execute({ text: '你好' });
      assert.equal(value.provider, 'bailian');
      assert.equal(value.model, 'qwen-audio-3.0-tts-plus');
    } finally {
      stub.restore();
    }
  });
});
