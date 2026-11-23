# Changelog

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
