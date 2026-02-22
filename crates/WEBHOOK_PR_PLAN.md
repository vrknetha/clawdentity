# Clawdentity Webhook PR Plan

Date: 2026-02-22
Owner fork account: `vrknetha`
Mission: add a generic `POST /webhook/clawdentity` inbound channel across 4 agent platforms so Clawdentity relay messages can be delivered in real time into each platform's existing agent loop.

## Phase 1 Completed: Contribution Process Review

| Repo | CONTRIBUTING.md | CODE_OF_CONDUCT.md | PR template | Notes that affect plan |
|---|---|---|---|---|
| `/Users/ravikiranvemula/Workdir/nanobot` | Not present (reviewed README contribution section) | Not present | Not present | No repo-level template/format constraints found; keep PR concise and focused. |
| `/Users/ravikiranvemula/Workdir/picoclaw` | Present and reviewed | No separate file; code-of-conduct section in CONTRIBUTING reviewed | `.github/pull_request_template.md` reviewed | Must follow conventional commits guidance and fill AI disclosure/test env sections in PR body. |
| `/Users/ravikiranvemula/Workdir/nano-claw-hustcc` | Present and reviewed | Not present | Not present | Recommends conventional commits and `feature/...` branch naming. |
| `/Users/ravikiranvemula/Workdir/nanoclaw-qwibitai` | Present and reviewed | Not present | `.github/PULL_REQUEST_TEMPLATE.md` reviewed | Feature additions are expected as skills; PR should be a skill package (no direct `src/` edits in same PR). |

## Shared Webhook Contract (All 4 PRs)

Endpoint and method:
- `POST /webhook/clawdentity`

Inbound headers accepted:
- `x-clawdentity-agent-did` (sender DID)
- `x-clawdentity-to-agent-did` (recipient DID)
- `x-clawdentity-verified` (`"true"` required)
- `x-clawdentity-token` (optional shared secret)
- `x-request-id`
- `content-type: application/json`

Behavioral contract:
- Parse JSON body as the relay payload (preserve raw payload in metadata when possible).
- Derive message text with fallback order: `payload.content` -> `payload.text` -> `payload.message` -> JSON string.
- Route to each platform's existing inbound bus/loop, not a separate processing path.
- Return `2xx` quickly after enqueue; reject malformed/auth-invalid requests with `4xx`.

Security baseline:
- Require `x-clawdentity-verified: true`.
- If local token is configured, require exact match on `x-clawdentity-token`.
- Default bind host should be loopback (`127.0.0.1`) unless explicitly configured otherwise.

---

## PR 1: NanoBot (Python) - `HKUDS/nanobot`

### What this PR adds
- New channel adapter: `ClawdentityChannel` with local HTTP server exposing `POST /webhook/clawdentity`.
- New config block under `channels.clawdentity` with fields like:
  - `enabled`
  - `webhook_host`
  - `webhook_port`
  - `webhook_path` (default `/webhook/clawdentity`)
  - `token` (optional)
  - `allow_from` (optional DID allowlist)
- Channel manager wiring so the new channel is created when enabled.

### How it hooks into existing bus/agent loop
- Request handler -> `ClawdentityChannel._handle_message(...)` (BaseChannel helper).
- Base channel publishes `InboundMessage` into `MessageBus.publish_inbound`.
- Existing `AgentLoop.run()` consumes and processes normally.
- Outbound path remains existing bus dispatcher; `send()` for this channel is a safe no-op/logging path (inbound-only transport).

### Planned files
- `nanobot/channels/clawdentity.py` (new)
- `nanobot/channels/manager.py` (register channel)
- `nanobot/config/schema.py` (config model)
- `tests/test_clawdentity_channel.py` (new)
- Optional docs: `README.md` channel config snippet

### Branch / commit / PR metadata
- Branch: `feature/clawdentity-webhook-channel`
- Commit message: `feat(channels): add clawdentity webhook inbound channel`
- PR title: `feat: add clawdentity webhook channel for inbound relay messages`
- PR body draft:

```md
## Summary
Add a new `clawdentity` inbound channel that exposes `POST /webhook/clawdentity` for local relay delivery.

## Why
Clawdentity connector delivers verified agent-to-agent messages over local HTTP. NanoBot currently lacks an HTTP ingress channel for this transport.

## What Changed
- Added `ClawdentityChannel` with webhook handler and header/token verification.
- Added `channels.clawdentity` config schema and manager registration.
- Mapped webhook payloads into NanoBot `InboundMessage` and existing session flow.
- Added unit tests for auth, payload parsing, and bus publish behavior.

## Validation
- `pytest tests/test_clawdentity_channel.py`
- `pytest`
```

### Tests to add
- `tests/test_clawdentity_channel.py`
  - accepts valid webhook and publishes expected inbound bus message.
  - rejects non-POST/malformed JSON.
  - rejects invalid/missing `x-clawdentity-verified`.
  - rejects token mismatch when token configured.
  - verifies metadata includes DIDs/request ID and payload fallback text extraction.

---

## PR 2: PicoClaw (Go) - `sipeed/picoclaw`

### What this PR adds
- New Go channel: `ClawdentityChannel` with `POST /webhook/clawdentity` HTTP ingress.
- New config type under `channels.clawdentity` with env bindings:
  - `enabled`
  - `webhook_host`
  - `webhook_port`
  - `webhook_path`
  - `token` (optional)
  - `allow_from`
- Manager initialization wiring and config defaults/example updates.

### How it hooks into existing bus/agent loop
- Webhook handler -> `BaseChannel.HandleMessage(...)`.
- `HandleMessage` publishes to `MessageBus.PublishInbound(...)`.
- Existing `AgentLoop.Run()` consumes inbound queue unchanged.
- Existing outbound dispatcher still runs; channel `Send(...)` is no-op/log for inbound-only mode.

### Planned files
- `pkg/channels/clawdentity.go` (new)
- `pkg/channels/manager.go` (init registration)
- `pkg/config/config.go` (new config struct)
- `pkg/config/defaults.go` (default values)
- `config/config.example.json` (sample config)
- `pkg/channels/clawdentity_test.go` (new)
- `pkg/config/config_test.go` (update default-channel assertions)

### Branch / commit / PR metadata
- Branch: `feat/clawdentity-webhook-channel`
- Commit message: `feat(channels): add clawdentity webhook channel`
- PR title: `feat: add clawdentity webhook channel for real-time relay ingress`
- PR body draft (aligned to template):

```md
## 📝 Description
Add a new `clawdentity` channel that accepts local relay messages via `POST /webhook/clawdentity` and feeds them into PicoClaw's existing inbound message bus.

## 🗣️ Type of Change
- [ ] 🐞 Bug fix (non-breaking change which fixes an issue)
- [x] ✨ New feature (non-breaking change which adds functionality)
- [ ] 📖 Documentation update
- [ ] ⚡ Code refactoring (no functional changes, no api changes)

## 🤖 AI Code Generation
- [ ] 🤖 Fully AI-generated (100% AI, 0% Human)
- [x] 🛠️ Mostly AI-generated (AI draft, Human verified/modified)
- [ ] 👨‍💻 Mostly Human-written (Human lead, AI assisted or none)

## 🔗 Related Issue
N/A (cross-project Clawdentity webhook integration)

## 📚 Technical Context (Skip for Docs)
- **Reference URL:** Clawdentity connector webhook delivery contract
- **Reasoning:** Reuse existing channel bus path (`HandleMessage` -> `PublishInbound`) to avoid introducing a parallel message pipeline.

## 🧪 Test Environment
- **Hardware:** Local dev machine
- **OS:** macOS
- **Model/Provider:** existing configured provider
- **Channels:** clawdentity (new inbound webhook)

## ☑️ Checklist
- [x] My code/docs follow the style of this project.
- [x] I have performed a self-review of my own changes.
- [x] I have updated the documentation accordingly.
```

### Tests to add
- `pkg/channels/clawdentity_test.go`
  - constructor/default path behavior.
  - header verification (`x-clawdentity-verified`, optional token).
  - malformed JSON handling.
  - publishes inbound message with expected channel/content/metadata.
- `pkg/config/config_test.go`
  - ensure default config contains disabled `channels.clawdentity` with expected webhook defaults.

---

## PR 3: NanoClaw (TypeScript) - `hustcc/nano-claw`

### What this PR adds
- New channel adapter: `ClawdentityChannel` (Node HTTP server).
- New config schema node `channels.clawdentity`:
  - `enabled`
  - `host`
  - `port`
  - `webhookPath` (default `/webhook/clawdentity`)
  - `token` (optional)
  - `allowFrom`
- Gateway registration so the channel is included in normal startup.
- Documentation update for configuration examples.

### How it hooks into existing bus/agent loop
- Incoming HTTP request -> `ClawdentityChannel.emitMessage(ChannelMessage)`.
- `ChannelManager` already forwards channel `message` events to `MessageBus.publish(...)`.
- `GatewayServer.handleMessage(...)` processes through existing `AgentLoop`.
- Response path uses existing `channelManager.sendMessage(...)`; for webhook channel this is intentionally no-op/log unless future outbound webhook support is added.

### Planned files
- `src/channels/clawdentity.ts` (new)
- `src/channels/index.ts` (export)
- `src/config/schema.ts` (schema)
- `src/gateway/server.ts` (registration)
- `documentation/CONFIGURATION.md` (new config section)
- `README.md` (channel list/config note)
- `src/channels/clawdentity.test.ts` (new)
- Optional: `src/config/schema.test.ts` (new)

### Branch / commit / PR metadata
- Branch: `feature/clawdentity-webhook-channel`
- Commit message: `feat(channels): add clawdentity webhook channel`
- PR title: `feat: add clawdentity webhook ingress channel`
- PR body draft:

```md
## Summary
Introduce a `clawdentity` channel with `POST /webhook/clawdentity` ingress and route inbound payloads through the existing MessageBus + Gateway + AgentLoop flow.

## Changes
- Added `ClawdentityChannel` with HTTP handler and header/token verification.
- Added `channels.clawdentity` config schema.
- Registered channel in gateway startup.
- Added tests and config docs.

## Validation
- `npm run test`
- `npm run build`
```

### Tests to add
- `src/channels/clawdentity.test.ts`
  - accepts valid webhook and emits `ChannelMessage` with expected fields.
  - rejects invalid method/path/headers/token.
  - parses payload and fallback content extraction.
  - enforces allowlist when configured.
- `src/config/schema.test.ts` (if added)
  - validates defaults and parsing for `channels.clawdentity`.

---

## PR 4: NanoClaw Claude Code (TypeScript) - `qwibitai/nanoclaw`

Contribution constraint from repo: feature additions should be delivered as **skills**, not direct source edits. Therefore this PR is a skill package that installs webhook channel code into NanoClaw.

### What this PR adds
- New skill package: `.claude/skills/add-clawdentity-webhook/`
  - `manifest.yaml`
  - `SKILL.md`
  - `add/src/channels/clawdentity.ts`
  - `add/src/channels/clawdentity.test.ts`
  - `modify/src/index.ts`
  - `modify/src/config.ts`
  - `modify/src/routing.test.ts`
  - intent docs for modified files
  - skill package tests under `tests/`
- When applied, skill adds runtime endpoint `POST /webhook/clawdentity` and wires channel into the existing multi-channel routing loop.

### How it hooks into existing bus/agent loop
- Applied code starts a local webhook channel that implements `Channel` interface.
- Inbound webhook writes `NewMessage` records via existing `onMessage -> storeMessage` path.
- Existing polling loop (`getNewMessages` -> `processGroupMessages` -> `runAgent`) remains unchanged.
- Outbound message routing continues through existing `findChannel(channels, jid)` behavior.

### Planned files (skill-only PR)
- `.claude/skills/add-clawdentity-webhook/**` (new directory tree)
- No direct `src/` edits in the PR itself (to satisfy repo contribution policy/checks).

### Branch / commit / PR metadata
- Branch: `skill/add-clawdentity-webhook`
- Commit message: `feat(skill): add clawdentity webhook channel skill`
- PR title: `Skill: add clawdentity webhook inbound channel`
- PR body draft (aligned to template):

```md
## Type of Change

- [x] **Skill** - adds a new skill in `.claude/skills/`
- [ ] **Fix** - bug fix or security fix to source code
- [ ] **Simplification** - reduces or simplifies source code

## Description

Add a new skill package `add-clawdentity-webhook` that, when applied, adds a local `POST /webhook/clawdentity` channel and wires inbound relay messages into NanoClaw's existing message storage + processing loop.

## For Skills

- [x] I have not made any changes to source code
- [x] My skill contains instructions for Claude to follow (not pre-built code)
- [x] I tested this skill on a fresh clone
```

### Tests to add
- `.claude/skills/add-clawdentity-webhook/tests/clawdentity-webhook.test.ts`
  - validates manifest content and declared files.
  - validates modified `index.ts` still preserves required core flow.
- `.claude/skills/add-clawdentity-webhook/add/src/channels/clawdentity.test.ts`
  - validates webhook handler auth/validation and message injection behavior.
- CI validation commands:
  - `npm test`
  - `npx vitest run --config vitest.skills.config.ts`
  - `npx tsx scripts/apply-skill.ts .claude/skills/add-clawdentity-webhook` on clean checkout and rerun tests.

---

## Execution Order (when implementation starts after review)

1. `picoclaw` first (closest existing HTTP channel pattern, strongest test scaffolding).
2. `nanobot` second (Python channel adapter with similar bus semantics).
3. `nano-claw-hustcc` third (new HTTP channel + first tests in repo).
4. `nanoclaw-qwibitai` fourth as skill-only PR to comply with repo policy.

## Push/PR targets

- Push all branches to `origin` (`vrknetha/*` forks).
- Open PRs from `vrknetha:<branch>` to upstream `main` in each repository.

