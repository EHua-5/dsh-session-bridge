# dsh-session-bridge（会话桥）

一个包，三条插件行，外加一个输入框开关：

| 入口 | 行 id | 作用 |
|---|---|---|
| `./inbox` | `inbox-bridge` | 本地 HTTP 收件箱：投递到活会话、`dedupeKey` 去重、可查投递结果 |
| `./model`（也是包根 `.`） | `session-model` | 跨会话工具：列会话/模型目录、给别的会话换模型、发消息；**客户端开关挂在这一行** |
| `./media` | `media` | 生成工具：`media_models` / `image_generate` / `video_generate` / `audio_generate`（9 种 provider 后端） |

客户端半在输入框的「模型 / 推理等级」菜单里加一行
**「允许其他会话更换本会话的模型」**（按会话生效，排在「启用智能体团队协作」下面）。
这是**被操作方同意**：别的会话只有在它开启时才能换它的模型；自己改自己的模型不受限制。
三条行可以分别开关。

接口、工具语义、provider 路由与安全说明见 [docs/DETAIL.md](docs/DETAIL.md)。

## 安装

用 Plugins 面板 / `plugin_manager`（从路径或源安装）。包根承载客户端半，作为 bundle 行插入；
`./inbox` 与 `./media` 是独立的两行。

## 测试

```bash
node --test test/inbox.test.js test/model.test.js test/media.test.js   # 88 条
```

没有独立 Node 时用 DSH 自带的 Electron：

```bash
ELECTRON_RUN_AS_NODE=1 "D:/DSH/DeepSeek Harness.exe" test/inbox.test.js
```

## 限制

- 客户端开关写死桥端口 `39881`，改端口要同步改 `client.js`。
- 客户端是手写 bundle，装好或改完要刷新页面。
- zhipu/fal/stability/elevenlabs/google/replicate 六家适配器是按官方文档写的，
  没有真实账号逐一验证，首次使用可能要做小字段修正。
- Google 需要 HTTP 代理（`media.providers.google.proxy`）且要有付费图片额度。
