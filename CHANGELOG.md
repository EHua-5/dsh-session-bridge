# Changelog

## 0.8.0 — 2026-11-23

- media 新增 6 家适配器：zhipu（CogView/CogVideoX）、fal（队列）、stability（multipart）、
  elevenlabs（TTS）、google（Imagen/Veo/Gemini TTS）、replicate（predictions）。
- 全部支持视频（除 stability/elevenlabs 本就不提供）；新增 `extra` 参数合并进请求体。
- 适配器按官方文档实现，未逐一真机验证。

## 0.7.0 — 2026-11-23

- media 按 provider 路由：`media.config.providers` 表（provider id → kind/host/apiKeyEnv）。
  新增 ark 适配器：图 `/api/v3/images/generations`、视频 `/api/v3/contents/generations/tasks` + 轮询；
  openai 适配器保留；dashscope 保留。
- 新增 `media_models` 工具：用 `ctx.llm.listProviders()/listModels()` 发现所有多模态模型，
  标出哪些 provider 已配置生成端点；调用时 `model` 用 `provider/model`。
- 没有 providers 表时保持旧的单后端配置兼容（默认 dashscope）。

## 0.6.0 — 2026-11-23

- `media` 支持 `provider: openai`：图片走 `/v1/images/generations`（b64_json，回退 url）、
  音频走 `/v1/audio/speech`（返回字节）；视频仍只支持 DashScope，`openai` 下明确报错。
- `config.host` 可覆盖端点（默认 dashscope=token-plan 主机，openai=api.openai.com）。

## 0.5.2 — 2026-11-23

- `session_message_send` 新增可选 `hint`：把“该用哪个工具（image_generate 等）、不需要切换聊天模型”
  以 `[提示：…]` 附在消息末尾，解决被沟通会话不知道要用工具/以为要换模型的问题。

## 0.5.1 — 2026-11-23

- 修客户端开关在会话忙碌时闪烁：菜单频繁重挂载，组件每次挂载都先返回 null 等 /features 请求，
  行先消失再出现。改为模块级缓存 + 单飞请求；加载中也保持整行渲染、开关暂时禁用。

## 0.5.0 — 2026-11-23

- 新增 `media` 行与三个生成工具：`image_generate`（生图，返回图片内容块）、
  `video_generate`（异步任务 + 轮询，下载 mp4）、`audio_generate`（TTS，下载 mp3）。
- 产物默认存 `~/.dsh/generated/`；key 依次取 config.apiKey / 环境变量 / `ctx.credentials`。
- 新增 `test/media.test.js`（fetch 打桩，7 条）。

## 0.4.5 — 2026-11-23

- 生成类模型拒绝文案更明确（说明这类模型通常只接受自己的生成 API，agent 回合会 400）；
  DETAIL 补实测结论。

## 0.4.4 — 2026-11-23

- 目录渲染补 `[media]` 标记（之前 kind 只在结构化返回值里，模型在文本上看不到）。

## 0.4.3 — 2026-11-23

- 生成类模型保护：`session_model_set` 默认拒绝 id/name 命中 image/video/audio/tts/asr/… 的模型，
  确需让会话产出这类内容时显式传 `allowNonChat: true`。
- `session_model_catalog` 每条模型带 `kind: chat|media`；`session_model_set` 返回 `kind`。

## 0.4.2 — 2026-11-23

- 修 `session_model_catalog` 在模型缺少 `reasoning`/`context` 元数据时整体失败：
  之前把 `defaultEffort: undefined` 写进返回值，工具输出要求 lossless JSON，导致整个调用报
  "value is not lossless JSON"。现在只写有值的字段。

## 0.4.1 — 2026-11-23

- 一致性修正：同意开关只约束**换模型**；`session_message_send` 不再要求目标开启开关
  （跨会话沟通是独立能力，之前被误关）。
- `session_model_list` 增加 `consent`，列表标出每个会话能否被别的会话换模型。
- 客户端说明只讲换模型；Switch 回调强制布尔。

## 0.4.0 — 2026-11-23

- 开关语义改为**目标会话同意**：写操作检查目标会话是否开启「允许其他会话更换本会话的模型」；
  自己改自己不受限制。
- 客户端文案改为「允许其他会话更换本会话的模型」。

## 0.3.2 — 2026-11-23

- 客户端开关改用与「启用智能体团队协作」同一套 primitives 的胶囊 Switch，并补上说明图标 + Tooltip。
- 文案改得更直白：「允许本会话换别人的模型」，说明里写清开启/关闭各能做什么。

## 0.3.1 — 2026-11-23

- 修复客户端半不加载：`dsh.client` 只会从**包根行**被发现。现在 patch 的 `session-model` 行直接指向包根
  （`@local/dsh-session-bridge`，导出 `./model.js`），收件箱仍是子路径行 `.../inbox`。
- `dsh.client.inject` 收窄为 conversation / model-selection / locale 三个真实包行。

## 0.3.0 — 2026-11-23

首个合包版本：把 `dsh-inbox-bridge`（0.2.1）与 `dsh-session-model`（0.2.0）合成一个包、两条插件行。

- 新增 `./inbox`、`./model` 两个入口；`cordis.patch.yml` 插入 `inbox-bridge`、`session-model` 两行，可分别开关。
- 新增客户端半：输入框模型菜单里的「启用跨会话换模型」（按会话，位于「启用智能体团队协作」下方）。
- 新增 `GET/POST /features/model-tools`（本机免 token）与状态文件 `~/.dsh/session-bridge-features.json`。
- `session_model_set` / `session_message_send` 现在要求调用方会话已开启开关；只读查询不受影响。
- 新增 `shared.js`：会话查找、消息构造、按会话开关存储（原子写）。
- 测试：收件箱 34 条 + 跨会话 19 条。
- 打包：README / LICENSE / CHANGELOG / docs / icon / locale；`files` 覆盖客户端半。
