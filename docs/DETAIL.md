# 会话桥（dsh-session-bridge）

一个包，两个入口、两条插件行：

| 入口 | 行 id | 作用 |
|---|---|---|
| `./inbox` | `inbox-bridge` | 本地 HTTP 收件箱：把文字投进活会话、按 `dedupeKey` 去重、可查投递结果 |
| `./model`（也是包根 `.`） | `session-model` | 跨会话工具：列活会话/模型目录、给指定会话换模型、给另一个会话发消息；**客户端开关挂在这一行** |

外加一个**客户端半**（`client.js`）：在输入框的「模型 / 推理等级」菜单里加一行
**「启用跨会话换模型」**（按会话生效，排在「启用智能体团队协作」下面）。

两条插件行可以**分别开关**：只用收件箱就关掉 `session-model`，反之亦然。
客户端的那个开关只挂在 `session-model` 这个包根行上——关掉该行，开关和 4 个工具一起消失。

## 收件箱（inbox-bridge）

```
GET  /health            计数、版本、config 状态（不回会话 id）
GET  /sessions          活会话列表（要 token）
GET  /delivery/{id}     一条投递的结果（要 token）
POST /config            改默认目标会话/端口（要 token）
POST /inbox             投一条消息（要 token）
GET/POST /features/model-tools   按会话的换模型开关（本机、免 token，见下）
```

- `POST /inbox` 默认 `202 {ok, queued, id, sessionId}`，立刻入队；
  `wait:true` 等结果为 200，等不到回 202；`onBusy=queue|wait|drop`；`dedupeKey` 15 分钟。
- 配置在 `~/.dsh/inbox-bridge.json`（`port` / `token` / `sessionId`），端口默认 39881，只监听 127.0.0.1。

## 换模型工具（session-model）

| 工具 | 作用 |
|---|---|
| `session_model_list` | 活会话、忙碌、当前模型、上一次请求实际用的模型（含"切换待生效"）；并标出每个会话"能否被换模型" |
| `session_model_catalog` | 可调模型：provider / model / 上下文窗口 / 推理强度 / 输入模态 |
| `session_model_set` | 给指定会话换模型，下一轮生效；跨会话默认通知对方；生成类模型默认拒绝 |
| `session_message_send` | 给另一个活会话发一条用户消息（对方忙就排下一轮） |
| `image_generate` | 调用生图接口生成图片，保存到 `~/.dsh/generated/`，返回文件路径与图片内容块 |
| `video_generate` | 提交异步视频任务并轮询，下载 mp4 到 `~/.dsh/generated/` |
| `audio_generate` | 语音合成（默认 `qwen-audio-3.0-tts-plus` / `longanlingxin`），下载 mp3 |

### 按会话开关

- 开关写在状态文件 `~/.dsh/session-bridge-features.json`：`{ "enabled": ["session-…"] }`。
- 语义是**目标会话同意（只针对换模型）**：`session_model_set` 要求**目标会话**已开启
  「允许其他会话更换本会话的模型」；自己改自己不受限制。
- `session_message_send` **不受**这个开关限制（跨会话沟通是独立能力）。
- **生成类模型保护**：id/name 命中 `image|video|audio|tts|asr|speech|embedding|rerank|moderation|ocr` 的模型
  默认拒绝；确实要让某个会话产出图片/视频/音频时，`session_model_set` 传 `allowNonChat: true`。
  **注意**：这类模型的 provider 通常只接受它自己的生成 API（例如 user-only 消息、list 形式的 content），
  agent 的完整对话格式会被 400 拒绝——实测 `bailian-tpp/wan2.7-image` 即如此。切过去只会让该会话的回合失败；
  要真正生图，应另加一个调用图像 API 的工具，而不是换会话模型。
  `session_model_catalog` 的每条模型都带 `kind: chat|media`。
- **只读**（`session_model_list`、`session_model_catalog`）不受影响。
- 开关入口：输入框模型菜单里的一行开关（客户端半），或直接 `POST /features/model-tools`。

## 生成类工具（media 行）

工具：`media_models`（发现可调用的生成模型）、`image_generate`、`video_generate`、`audio_generate`。

`media.config.providers`（键为 llm provider id）决定调用哪个厂商的原生接口：

| kind | 能力 | 端点 | 默认模型 |
|---|---|---|---|
| `dashscope` | 图/视频/音频 | 阿里百炼系 | wan2.7-image / wan3.0-video / qwen-audio-3.0-tts-plus |
| `openai` | 图/音频 | `/v1/images/generations`、`/v1/audio/speech` | gpt-image-1 / tts-1 |
| `ark` | 图/视频 | `/api/v3/images/generations`、`/api/v3/contents/generations/tasks` | 需显式指定（Seedream/Seedance 版本多） |
| `zhipu` | 图/视频 | `/api/paas/v4/images/generations`、`/api/paas/v4/videos/generations` | cogview-4 / cogvideox-3 |
| `fal` | 图/视频 | `queue.fal.run/{model}` 队列 | 需给 fal 模型路径 |
| `stability` | 图 | `/v2beta/stable-image/generate/core`（multipart） | 无需 model |
| `elevenlabs` | 音频 | `/v1/text-to-speech/{voice}` | eleven_multilingual_v2 |
| `google` | 图/视频/音频 | Imagen `:predict`、Veo `:predictLongRunning`、Gemini TTS | imagen-4.0-generate-001 / veo-3.1-generate-preview / gemini-2.5-flash-preview-tts |
| `replicate` | 图/视频/音频 | `/v1/predictions` + 轮询 | 需 `owner/name` 或 `owner/name:version` |

配置示例：

```yaml
providers:
  ark:     { kind: ark,        host: https://ark.cn-beijing.volces.com, apiKeyEnv: ARK_API_KEY }
  google:  { kind: google,     host: https://generativelanguage.googleapis.com, apiKeyEnv: GEMINI_API_KEY }
  fal:     { kind: fal,        host: https://queue.fal.run, apiKeyEnv: FAL_KEY }
  replicate:{ kind: replicate, host: https://api.replicate.com, apiKeyEnv: REPLICATE_API_TOKEN }
  zhipu:   { kind: zhipu,      host: https://open.bigmodel.cn, apiKeyEnv: ZHIPU_API_KEY }
  stability:{kind: stability,  host: https://api.stability.ai, apiKeyEnv: STABILITY_API_KEY }
  eleven:  { kind: elevenlabs, host: https://api.elevenlabs.io, apiKeyEnv: ELEVENLABS_API_KEY, voice: <voice_id> }
```

- 调用时 `model` 传 `provider/model`；省略走 `defaultProvider` 或唯一配置项。
- `extra` 参数原样合并进请求体（replicate 合并进 `input`），用于模型私有字段。
- 没有 `providers` 表时退回旧的单后端配置（`provider`/`host`/`apiKeyEnv`/`apiKey`），默认 dashscope。
- 产物默认存 `~/.dsh/generated/`；图片经附件服务转 image block。
- 适配器按官方文档实现；除 dashscope/openai/ark 外未逐一真机验证，首次调用如报错按错误信息微调。

## 安全说明

- HTTP 服务只绑定 `127.0.0.1`；写操作要 `X-Inbox-Token`。
- `/features/model-tools` **故意不校验 token**：页面（另一个本地端口）拿不到桥的 token，
  而这个端点只决定"某个会话能否发起换模型/发消息"，不读不写任何消息内容。
  它的 CORS 是 `*`，只在本机可用。若你不接受这一点，可以停用 `inbox-bridge` 行，
  换模型开关随之不可用（工具仍按最后一次状态生效）。

## 安装

```bash
dsh plugin --profile <name> add @scope/dsh-session-bridge
```

本地目录：

```bash
dsh plugin --profile <name> add F:\Dsh_work\dsh-session-bridge
```

## 测试

```bash
node test/inbox.test.js    # 34 条
node test/model.test.js    # 19 条
```

本机没有独立 node 时，用 DSH 自带的 Electron：

```bash
ELECTRON_RUN_AS_NODE=1 "D:/DSH/DeepSeek Harness.exe" test/inbox.test.js
```

## 已知限制

- 客户端开关的端口写死为 `39881`；改桥端口要同步改 `client.js` 里的 `BRIDGE`。
- 客户端半是手写 bundle：装好或改完后要刷新页面才生效。
- 只操作活会话；改模型不碰 agent 预设、默认模型和历史。
