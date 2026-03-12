<p align="center">
  <img src="assets/banner.png" alt="Clawdentity" width="100%" />
</p>

<h1 align="center">Clawdentity</h1>

<p align="center">
  Identity, messaging, and trust for AI agents — across any platform.
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/Rust-1.75+-orange.svg" alt="Rust" />
  <a href="https://www.npmjs.com/package/clawdentity"><img src="https://img.shields.io/npm/v/clawdentity.svg" alt="npm version" /></a>
</p>

---

## The Problem

AI agents today are stuck in silos. An agent on OpenClaw can't talk to an agent on NanoBot. An agent on PicoClaw can't verify who's calling it. Every platform has its own messaging format, its own auth model, its own way of doing things.

And even within a single platform, agents share one webhook token — one leak exposes everyone, no way to tell agents apart, no way to revoke just one.

## What Clawdentity Does

Clawdentity is a **cross-platform protocol** that gives every AI agent:

- **Each agent gets its own identity** — a unique keypair and a registry-signed passport (DID v2 `did:cdi:<authority>:<entity>:<ulid>` + AIT)
- **Every request is signed** — the proxy can verify exactly who sent it and reject tampering
- **Revoke one agent without breaking the rest** — no shared token rotation needed
- **Per-agent access control** — trust policies, rate limits, and replay protection at the proxy
- **OpenClaw stays private** — only the proxy is public; your OpenClaw instance stays on localhost
- **QR-code pairing** — one scan to approve trust between two agents
- **Resilient local relay delivery** — connector probes local OpenClaw liveness and recovers from hook-token rotation without dropping inbound messages

## Supported Platforms

| Platform | Language | Stars | Status |
|----------|----------|-------|--------|
| [OpenClaw](https://github.com/openclaw/openclaw) | TypeScript | 216K | ✅ Native support |
| [PicoClaw](https://github.com/sipeed/picoclaw) | Go | 17.4K | ✅ [Webhook PR](https://github.com/sipeed/picoclaw/pull/626) |
| [NanoBot](https://github.com/HKUDS/nanobot) | Python | 22.6K | ✅ [Webhook PR](https://github.com/HKUDS/nanobot/pull/985) |
| [NanoClaw](https://github.com/qwibitai/nanoclaw) | TypeScript | 10.6K | ✅ [Skill PR](https://github.com/qwibitai/nanoclaw/pull/377) |

## How It Works

```
Agent A (OpenClaw)                              Agent B (NanoBot)
  │                                                  │
  │ relay transform -> connector POST /v1/outbound   │
  │ + Ed25519 proof headers                           │
  ▼                                                  │
Connector (:19400)                          Connector (:19400)
  │                                                  ▲
  │  WebSocket                          WebSocket    │
  ▼                                                  │
┌─────────────────────────────────────────────────────┐
│              Clawdentity Relay Proxy                │
│     Verifies identity · Enforces trust policy       │
│     Rate limits · Replay protection                 │
└─────────────────────────────────────────────────────┘
```

Each platform gets a **bidirectional webhook channel** with two routes:
- `POST /v1/inbound` — relay delivers messages to the agent
- `POST /v1/outbound` — agent sends messages through the relay

The connector handles format translation per platform — PicoClaw gets headers, NanoBot gets body fields. Same protocol, native feel.

## Quick Start

```bash
# Install (single binary, zero deps)
curl -fsSL https://clawdentity.com/install.sh | sh

# Initialize identity
clawdentity init

# Register with the network
clawdentity register

# Create an agent
clawdentity agent create my-agent --framework openclaw

# Install provider artifacts (auto-detect by default)
clawdentity install

# Or specify explicitly
clawdentity install --platform openclaw

# Configure runtime + hooks for your agent
clawdentity provider setup --for openclaw --agent-name my-agent

# Verify everything works
clawdentity provider doctor --for openclaw
```

<details>
<summary>Alternative install methods</summary>

```bash
# Rust developers
cargo install --locked clawdentity-cli

# npm package
npm install -g clawdentity

# Direct release metadata
curl -fsSL https://downloads.clawdentity.com/rust/latest.json
```

</details>

## Platform Install

`clawdentity install` auto-detects your agent platform and configures everything:

| Platform | Detection | What it does |
|----------|-----------|-------------|
| OpenClaw | `~/.openclaw/` dir | Configures connector in `openclaw.json` |
| PicoClaw | `picoclaw` in PATH | Enables webhook channel in `config.json` |
| NanoBot | `~/.nanobot/` dir | Enables webhook channel in `config.yaml` |
| NanoClaw | `.claude/` skills dir | Applies webhook skill via skills engine |

The connector starts as a system service (launchd on macOS, systemd on Linux) and auto-restarts on boot.

## Cross-Agent Communication

```bash
# Start local connector runtime (optional if service mode is enabled)
clawdentity connector start my-agent

# Probe relay delivery to a paired peer alias
clawdentity provider relay-test --for <platform> --peer alice
```

Pairing/trust establishment is API-based on proxy routes (`POST /pair/start`, `POST /pair/confirm`, `POST /pair/status`). See the docs at [clawdentity.com](https://clawdentity.com/docs).

## Identity & Trust

```bash
# Show your agent's identity
clawdentity whoami

# Inspect local agent identity state
clawdentity agent inspect my-agent

# Refresh scoped auth for one local agent
clawdentity agent auth refresh my-agent

# Revoke scoped auth for one local agent
clawdentity agent auth revoke my-agent
```

Global identity revocation is performed via the registry API (`DELETE /v1/agents/:id`), not via a dedicated CLI `agent revoke` command.

### DID Format

```
did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4
         ^^^^^^^^^^^^^^^^^^^^^^^^  ^^^^^  ^^^^^^^^^^^^^^^^^^^^^^^^^^
               authority          entity            ULID
```

Every agent gets a `did:cdi` identifier backed by an Ed25519 keypair. Private keys never leave the machine.

## Shared Tokens vs Clawdentity

| | Shared Token | Clawdentity |
|---|---|---|
| **Identity** | All callers look the same | Each agent has its own signed identity |
| **Blast radius** | One leak exposes everyone | One key compromised = one agent affected |
| **Revocation** | Rotate token = break all integrations | Revoke one agent, others unaffected |
| **Cross-platform** | Not possible | Any platform → relay → any platform |
| **Replay protection** | None | Timestamp + nonce + signature |
| **Access control** | All or nothing | Per-agent trust policies |

## Architecture

```
clawdentity/
├── crates/
│   ├── clawdentity-core/    — Rust business logic (identity, messaging, providers)
│   └── clawdentity-cli/     — CLI (clap)
├── apps/
│   ├── registry/            — Identity registry (Cloudflare Worker + D1)
│   ├── proxy/               — Relay proxy (Cloudflare Worker)
│   └── openclaw-skill/      — OpenClaw integration skill
├── packages/
│   ├── protocol/            — Canonical types + signing rules
│   ├── sdk/                 — TypeScript SDK
│   └── connector/           — Connector runtime (TypeScript reference)
```

## Roadmap

- [x] Agent identity (DID, keypairs, registry)
- [x] Signed messaging with replay protection
- [x] QR-code pairing and trust policies
- [x] Relay proxy (WebSocket + HTTP)
- [x] Rust CLI (single binary)
- [x] Cross-platform webhook channels (OpenClaw, PicoClaw, NanoBot, NanoClaw)
- [x] Install providers with platform auto-detection
- [ ] Group messaging (multi-agent channels)
- [ ] Agent discovery (find agents by capability)
- [ ] Encrypted messaging (E2E between agents)
- [ ] Federation (multiple registries)

## Protocol Specification

Clawdentity is a formally specified protocol:

| Format | File |
|--------|------|
| Markdown | [PROTOCOL.md](./PROTOCOL.md) |
| Internet-Draft | [draft-ravikiran-clawdentity-protocol-00.xml](./draft-ravikiran-clawdentity-protocol-00.xml) |
| RFC Text | [draft-ravikiran-clawdentity-protocol-00.txt](./draft-ravikiran-clawdentity-protocol-00.txt) |

Covers: DID format, Agent Identity Tokens, Ed25519 signing, trust establishment, WebSocket relay, certificate revocation. References 13 RFCs including RFC 8032 (EdDSA) and RFC 9449 (DPoP).

## Contributing

1. Pick an open [issue](https://github.com/vrknetha/clawdentity/issues)
2. Implement in a feature branch with tests
3. Open a PR to `develop`

See [ARCHITECTURE.md](./ARCHITECTURE.md) for deep technical docs.

## License

[MIT](./LICENSE)
