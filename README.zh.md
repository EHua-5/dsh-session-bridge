# dsh-session-bridge（会话桥）

一个包，两条插件行，外加一个输入框开关：

| 入口 | 行 | 作用 |
|---|---|---|
| `./inbox` | `inbox-bridge` | 本地 HTTP 收件箱：投递到活会话、`dedupeKey` 去重、可查投递结果 |
| `./model` | `session-model` | 跨会话工具：列会话/模型目录、给别的会话换模型、给别的会话发消息 |

客户端半在输入框的「模型 / 推理等级」菜单里加一行
**「启用跨会话换模型」**（按会话生效，排在「启用智能体团队协作」下面）。
两条行可以分别开关。

接口、工具语义、开关行为与安全说明见 [docs/DETAIL.md](docs/DETAIL.md)。

## 安装

```bash
dsh plugin --profile <name> add @scope/dsh-session-bridge
```

## 测试

```bash
node test/inbox.test.js
node test/model.test.js
```

## 限制

- 客户端开关写死桥端口 `39881`，改端口要同步改 `client.js`。
- 客户端是手写 bundle，装好或改完要刷新页面。
