# 会话桥（dsh-session-bridge）

一个包，两个入口、两条插件行：

| 入口 | 行 id | 作用 |
|---|---|---|
| `./inbox` | `inbox-bridge` | 本地 HTTP 收件箱：把文字投进活会话、按 `dedupeKey` 去重、可查投递结果 |
| `./model` | `session-model` | 跨会话工具：列活会话/模型目录、给指定会话换模型、给另一个会话发消息 |

外加一个**客户端半**（`client.js`）：在输入框的「模型 / 推理等级」菜单里加一行
**「启用跨会话换模型」**（按会话生效，排在「启用智能体团队协作」下面）。

两条插件行可以**分别开关**：只用收件箱就关掉 `session-model`，反之亦然。

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
| `session_model_list` | 活会话、忙碌、当前模型、上一次请求实际用的模型（含"切换待生效"） |
| `session_model_catalog` | 可调模型：provider / model / 上下文窗口 / 推理强度 / 输入模态 |
| `session_model_set` | 给指定会话换模型，下一轮生效；跨会话默认通知对方 |
| `session_message_send` | 给另一个活会话发一条用户消息（对方忙就排下一轮） |

### 按会话开关

- 开关写在状态文件 `~/.dsh/session-bridge-features.json`：`{ "enabled": ["session-…"] }`。
- **写操作**（`session_model_set`、`session_message_send`）要求调用方会话已开启；
  **只读**（`session_model_list`、`session_model_catalog`）不受影响。
- 开关入口：输入框模型菜单里的一行开关（客户端半），或直接 `POST /features/model-tools`。

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
