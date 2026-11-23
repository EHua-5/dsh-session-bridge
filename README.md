# dsh-session-bridge

One package, two plugin rows, plus a composer switch:

| Entry | Row | What it does |
|---|---|---|
| `./inbox` | `inbox-bridge` | Local HTTP inbox: deliver text into a live session, dedupe by `dedupeKey`, query delivery results |
| `./model` | `session-model` | Cross-session tools: list sessions/models, switch another session's model, message another session |

A small client half adds **“Enable cross-session model changes”** to the composer's model menu,
per session, right below “Enable agent teamwork”. The two rows can be enabled independently.

See [docs/DETAIL.md](docs/DETAIL.md) for endpoints, tool semantics, the per-session switch,
and the security note about the token-less local `/features` endpoint.

## Install

```bash
dsh plugin --profile <name> add @scope/dsh-session-bridge
```

## Test

```bash
node test/inbox.test.js
node test/model.test.js
```

## Limitations

- The client switch hard-codes the bridge port `39881`; change `client.js` if you change it.
- The client half is a hand-written bundle: refresh the page after installing or changing it.
