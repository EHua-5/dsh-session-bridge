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
  await assert.rejects(() => tools.video.execute({ prompt: 'x' }), /没有标准的视频生成接口/);
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
