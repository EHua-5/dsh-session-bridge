# Changelog

## 0.3.0 — 2026-11-23

首个合包版本：把 `dsh-inbox-bridge`（0.2.1）与 `dsh-session-model`（0.2.0）合成一个包、两条插件行。

- 新增 `./inbox`、`./model` 两个入口；`cordis.patch.yml` 插入 `inbox-bridge`、`session-model` 两行，可分别开关。
- 新增客户端半：输入框模型菜单里的「启用跨会话换模型」（按会话，位于「启用智能体团队协作」下方）。
- 新增 `GET/POST /features/model-tools`（本机免 token）与状态文件 `~/.dsh/session-bridge-features.json`。
- `session_model_set` / `session_message_send` 现在要求调用方会话已开启开关；只读查询不受影响。
- 新增 `shared.js`：会话查找、消息构造、按会话开关存储（原子写）。
- 测试：收件箱 34 条 + 跨会话 19 条。
- 打包：README / LICENSE / CHANGELOG / docs / icon / locale；`files` 覆盖客户端半。
