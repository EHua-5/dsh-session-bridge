# dsh-session-bridge

One package, three plugin rows, plus a composer switch:

| Entry | Row | What it does |
|---|---|---|
| `./inbox` | `inbox-bridge` | Local HTTP inbox: deliver text into a live session, `dedupeKey` dedupe, delivery lookup |
| `./model` (also package root `.`) | `session-model` | Cross-session tools: list sessions/models, switch another session's model, message another session; **the composer switch rides this row** |
| `./media` | `media` | Generation tools: `media_models`, `image_generate`, `video_generate`, `audio_generate` (9 provider backends) |

The client half adds **“Allow other sessions to change this one”** to the composer's model menu,
per session, right below “Enable agent teamwork”. It is **target consent**: another session may
switch this one's model only while the switch is on (switching its own model is always allowed).
The three rows can be enabled independently.

See [docs/DETAIL.md](docs/DETAIL.md) for endpoints, tool semantics, provider routing,
and the security note about the token-less local `/features` endpoint.

## Install

Use the Plugins panel / `plugin_manager` (install from path or registry). The package root
carries the client half and is inserted as a bundle row; `./inbox` and `./media` are separate rows.

## Test

```bash
node --test test/inbox.test.js test/model.test.js test/media.test.js   # 88 tests
```

On a machine without a standalone Node, run the same files with DSH's Electron:

```bash
ELECTRON_RUN_AS_NODE=1 "D:/DSH/DeepSeek Harness.exe" test/inbox.test.js
```

## Limitations

- The client switch hard-codes the bridge port `39881`; change `client.js` if you change it.
- The client half is a hand-written bundle: refresh the page after installing or changing it.
- `media` adapters for zhipu/fal/stability/elevenlabs/google/replicate are written against the
  official docs but not verified against live accounts; expect small field fixes on first use.
- Google needs an HTTP proxy (`media.providers.google.proxy`) and a paid image quota.
