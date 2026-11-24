import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMediaTools } from '../media.js';

const cred = fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8');
const match = /GOOGLE_API_KEY:\s*(\S+)/.exec(cred);
if (!match) throw new Error('GOOGLE_API_KEY not found');
const key = match[1].trim().replace(/^["']|["']$/g, '');

const tools = createMediaTools({ attachments: undefined, get: () => undefined }, {
  outputDir: 'F:\\Dsh_work\\DSH_QQ\\tmp\\gtest',
  providers: {
    google: {
      kind: 'google',
      host: 'https://generativelanguage.googleapis.com',
      apiKey: key,
      proxy: 'http://127.0.0.1:7890',
    },
  },
});

const value = await tools.image.execute({
  prompt: '水彩风格：雪地里的一只小狐狸，正方形构图',
  model: 'google/gemini-3.1-flash-lite-image',
});
console.log(JSON.stringify({ file: value.file, bytes: value.bytes, provider: value.provider, model: value.model }));
