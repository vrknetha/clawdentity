# Platform Messaging/Channel Integration Research

Date: 2026-02-22

## Scope and snapshots

| Platform | Local clone path | Snapshot commit |
|---|---|---|
| NanoBot (HKUDS/nanobot, Python) | `/Users/ravikiranvemula/Workdir/nanobot` | `0040c62b7420c2a6505f864c1a49ddcffd394a81` |
| PicoClaw (sipeed/picoclaw, Go) | `/Users/ravikiranvemula/Workdir/picoclaw` | `b9a66248d8fd88644f1fec3f8be35fbbc23d4803` |
| NanoClaw (hustcc/nano-claw, TypeScript/Node) | `/Users/ravikiranvemula/Workdir/nano-claw-hustcc` | `5cae6f31efc3606422a02d59cc6f4c35fd9d556d` |
| NanoClaw (qwibitai/nanoclaw, Claude Code based) | `/Users/ravikiranvemula/Workdir/nanoclaw-qwibitai` | `1980d97d90971f8979b2d1277c1b8db67803b08a` |

## Reference pattern (Clawdentity OpenClaw skill)

Target pattern reference files:
- `/Users/ravikiranvemula/Workdir/clawdentity/apps/openclaw-skill/skill/SKILL.md`
- `/Users/ravikiranvemula/Workdir/clawdentity/apps/openclaw-skill/skill/references/clawdentity-protocol.md`

Relevant traits to replicate:
- Inbound relay hook is transform-driven (`ctx.payload` inspection + peer routing) and not tied to a single chat provider.
- Outbound handoff is local connector first (`/v1/outbound`), with auth/signing delegated to connector runtime.
- Skill install/use is file-based with deterministic location (`~/.openclaw/skills/.../SKILL.md`) and strict state contracts.
- Config is split by concern (`~/.openclaw/openclaw.json`, `~/.clawdentity/config.json`, `~/.clawdentity/openclaw-relay.json`).

## Comparison table

Extensibility rating legend:
- `Yes`: can add channel/transport as plugin/module without editing central router/manager.
- `Partial`: channel interface exists, but central registration/routing still needs code changes.
- `No`: transport logic is tightly hardcoded.

| Platform | 1) Inbound hook | 2) Outbound hook | 3) Skill/tool registration | 4) Config location | 5) Extensibility point |
|---|---|---|---|---|---|
| NanoBot (HKUDS) | Channel adapters call `BaseChannel._handle_message`, then bus enqueue via `MessageBus.publish_inbound`. (`nanobot/channels/base.py:34-125`, `nanobot/bus/queue.py:16-34`) | Agent loop publishes outbound to bus; channel manager drains bus and calls channel `send()`. (`nanobot/agent/loop.py:166-217`, `nanobot/channels/manager.py:185-204`) | `SkillsLoader` scans workspace/global `skills`, parses `SKILL.md`; tools registered through `ToolRegistry` + default registrations in agent loop. (`nanobot/agent/skills.py:26-190`, `nanobot/agent/tools/registry.py:12-63`, `nanobot/agent/loop.py:52-127`) | User config file `~/.nanobot/config.json` (documented in README), schema in Pydantic config models. (`README.md`, `nanobot/config/schema.py:1-210`) | `Partial`: new channel class via `BaseChannel`, but `_init_channels` in manager still needs wiring. (`nanobot/channels/manager.py:34-139`) |
| PicoClaw (sipeed) | Channel webhook/stream handlers call shared `HandleMessage` and publish to inbound bus. (`pkg/channels/line.go:70-389`, `pkg/channels/base.go:84-99`, `pkg/bus/bus.go:24-40`) | Agent/shared tools publish outbound events; manager dispatcher routes by channel and calls `Send`. (`pkg/agent/loop.go:95-192`, `pkg/channels/manager.go:271-307`) | Runtime skills tooling exposed as tools (`find_skills`, `install_skill`), plus SKILL loader walks workspace/global/builtin skill dirs. (`pkg/agent/loop.go:95-150`, `pkg/tools/skills_search.go:11-118`, `pkg/tools/skills_install.go:17-175`, `pkg/skills/loader.go:56-210`) | Central Go `Config` struct + JSON example (`config/config.example.json`); repo/docs indicate `config/config.json` or `~/.picoclaw/config.json`. (`pkg/config/config.go:49-220`, `config/config.example.json:80-220`) | `Partial`: `Channel` interface is clean, but adding a transport requires manager init wiring. (`pkg/channels/base.go:10-100`, `pkg/channels/manager.go:46-204`) |
| NanoClaw (hustcc) | Each channel emits `'message'`; channel manager forwards to singleton bus on registration. (`src/channels/manager.ts:23-45`) | Gateway server handles message and sends final/error replies through `ChannelManager.sendMessage`. (`src/gateway/server.ts:148-194`, `src/channels/manager.ts:83-120`) | Markdown skill discovery from `~/.nano-claw/skills/*.md`; tool registry supports dynamic register/execute and built-ins are attached in agent loop. (`src/agent/skills.ts:10-117`, `src/agent/tools/registry.ts:1-102`, `src/agent/loop.ts:34-74`) | `~/.nano-claw/config.json` via helper path resolution and config load/save methods. (`src/utils/helpers.ts:5-38`, `src/config/index.ts:10-55`) | `Partial`: extend `BaseChannel` and schema, then wire into gateway registration list. (`src/channels/base.ts:10-93`, `src/config/schema.ts:65-181`, `src/gateway/server.ts:70-96`) |
| NanoClaw (qwibitai) | Current primary inbound channel (WhatsApp) calls `onMessage`, then stores inbound message in DB before agent processing. (`src/channels/whatsapp.ts:189`, `src/index.ts:428`, `src/db.ts:239`) | Agent/scheduler/IPC routes all send paths to channel `sendMessage` using transport lookup helpers. (`src/index.ts:175`, `src/task-scheduler.ts:118`, `src/router.ts:23`, `src/index.ts:442`, `src/index.ts:457`) | Skill engine uses `.nanoclaw` state + apply/replay flows, discovers skill manifests from `.claude/skills`, and container runner syncs skills into runtime. (`skills-engine/state.ts:10`, `skills-engine/apply.ts:38`, `skills-engine/apply.ts:316`, `skills-engine/replay.ts:42`, `src/container-runner.ts:129`) | Hybrid config: `.env` + constants in `src/config.ts`; mount allowlist in `~/.config/nanoclaw/mount-allowlist.json`. (`src/env.ts:1`, `src/config.ts:6`, `src/config.ts:25`, `config-examples/mount-allowlist.json:1`) | `Partial`: channel abstraction exists, but channel list/selection is wired in main/router. (`src/types.ts:81`, `src/index.ts:52`, `src/router.ts:39`) |

## Detailed findings by platform

### NanoBot (HKUDS/nanobot)

- Inbound hook:
  - `nanobot gateway` CLI initializes `ChannelManager` and starts enabled channels. (`nanobot/cli/commands.py:326-369`)
  - Channel adapters funnel inbound events through `BaseChannel._handle_message` with validation + bus publish. (`nanobot/channels/base.py:34-125`)
  - Bus ingress endpoint: `MessageBus.publish_inbound`. (`nanobot/bus/queue.py:16-34`)
- Outbound hook:
  - `AgentLoop.run` publishes outbound messages after inference/tool execution. (`nanobot/agent/loop.py:166-217`)
  - `ChannelManager._dispatch_outbound` consumes bus events and calls channel `send()`. (`nanobot/channels/manager.py:185-204`)
- Skill/tool registration:
  - `SkillsLoader` scans `<workspace>/skills` then bundled skills, parses frontmatter, and loads content by skill name. (`nanobot/agent/skills.py:26-190`)
  - Built-in tool registration happens in agent loop via `ToolRegistry.register(...)`. (`nanobot/agent/loop.py:52-127`, `nanobot/agent/tools/registry.py:12-63`)
- Config location:
  - Primary user config: `~/.nanobot/config.json` (README documented).
  - Structured config schema/models in `nanobot/config/schema.py:1-210`.
- Extensibility:
  - Channel abstraction is good (`BaseChannel` contract), but manager still hardcodes enabled channel families in `_init_channels`.
  - Net: addable with moderate changes, but not drop-in plugin loading.

### PicoClaw (sipeed/picoclaw)

- Inbound hook:
  - Channel endpoint handlers (example: LINE webhook) verify/process events and pass normalized messages into `HandleMessage`. (`pkg/channels/line.go:70-389`, `pkg/channels/base.go:84-99`)
  - Shared bus ingress is `PublishInbound`. (`pkg/bus/bus.go:24-40`)
- Outbound hook:
  - Agent loop/shared message tool emits `PublishOutbound`. (`pkg/agent/loop.go:95-192`)
  - Channel manager dispatcher reads outbound queue and invokes per-channel `Send`. (`pkg/channels/manager.go:271-307`)
- Skill/tool registration:
  - Tool layer includes searchable/installable skill registries (`find_skills`, `install_skill`). (`pkg/agent/loop.go:95-150`, `pkg/tools/skills_search.go:11-118`, `pkg/tools/skills_install.go:17-175`)
  - Skill metadata/content loader walks workspace/global/builtin locations. (`pkg/skills/loader.go:56-210`)
- Config location:
  - Typed config model in `pkg/config/config.go:49-220`.
  - Example concrete config in `config/config.example.json:80-220` (used for `config/config.json` / `~/.picoclaw/config.json` deployments).
- Extensibility:
  - `Channel` interface is explicit (`pkg/channels/base.go:10-100`).
  - New transport still needs explicit manager registration (`pkg/channels/manager.go:46-204`), though runtime register/unregister helpers exist (`pkg/channels/manager.go:343-371`).

### NanoClaw (hustcc/nano-claw)

- Inbound hook:
  - Channel manager subscribes to each channel's `'message'` event and republishes to the message bus. (`src/channels/manager.ts:23-45`)
- Outbound hook:
  - Gateway message flow sends final/error responses back through `ChannelManager.sendMessage(...)`. (`src/gateway/server.ts:148-194`)
- Skill/tool registration:
  - Skills are discovered from Markdown files under `~/.nano-claw/skills/`. (`src/agent/skills.ts:10-117`)
  - Tool extensibility uses `ToolRegistry.register/getDefinitions/execute`; built-ins are registered in `AgentLoop.registerBuiltInTools`. (`src/agent/tools/registry.ts:1-102`, `src/agent/loop.ts:34-74`)
- Config location:
  - Resolved config path is `~/.nano-claw/config.json`. (`src/utils/helpers.ts:5-38`)
  - `loadConfig`/`saveConfig` centralized in `src/config/index.ts:10-55`.
- Extensibility:
  - New transport needs `BaseChannel` implementation + schema entry + registration in gateway setup.
  - Net: modular interface, but not auto-discovered plugin channels.

### NanoClaw (qwibitai/nanoclaw)

- Inbound hook:
  - WhatsApp channel callback (`onMessage`) is the active ingress path; messages are persisted with metadata then consumed by agent flow. (`src/channels/whatsapp.ts:189`, `src/index.ts:428`, `src/db.ts:239`)
- Outbound hook:
  - `runAgent`, scheduler task execution, and IPC watcher all route through channel `sendMessage` with channel lookup helpers. (`src/index.ts:175`, `src/task-scheduler.ts:118`, `src/router.ts:23`, `src/index.ts:442`, `src/index.ts:457`)
- Skill/tool registration:
  - Skill lifecycle managed in `skills-engine/*`: apply/record state/replay.
  - Discovery from `.claude/skills` manifests and runtime sync into containerized `.claude/skills`. (`skills-engine/state.ts:10`, `skills-engine/apply.ts:38`, `skills-engine/apply.ts:316`, `skills-engine/replay.ts:42`, `src/container-runner.ts:129`)
- Config location:
  - `.env` ingestion in `src/env.ts`, runtime constants in `src/config.ts`.
  - Mount transport/security allowlist file at `~/.config/nanoclaw/mount-allowlist.json` (example in `config-examples/mount-allowlist.json`).
- Extensibility:
  - `Channel` interface exists (`src/types.ts:81`), but transport list and dispatch are manually wired in `main`/router.
  - Net: extendable, but still central-code-touch required.

## Practical takeaways for Clawdentity parity

- The strongest reusable pattern across all four projects is:
  - `channel adapters -> normalized inbound event -> central bus -> agent loop -> central outbound bus -> channel sender`.
- None of the four repositories currently provide fully decoupled channel plugins that can be dropped in with zero core changes.
- For OpenClaw-style parity (from `apps/openclaw-skill/skill/SKILL.md` and protocol reference), the closest fit is:
  - keep relay transform + connector handoff as fixed ingress/egress contract,
  - keep skill discovery file-based and deterministic,
  - keep transport adapters behind a stable interface with explicit registration points.
