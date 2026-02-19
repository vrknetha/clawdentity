<p align="center">
  <img src="assets/banner.png" alt="Clawdentity" width="100%" />
</p>

<h1 align="center">Clawdentity</h1>

<p align="center">
  Verified identity + instant revocation for AI agents — starting with <strong>OpenClaw</strong>.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/clawdentity"><img src="https://img.shields.io/npm/v/clawdentity.svg" alt="npm version" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg" alt="Node 22+" />
  <img src="https://img.shields.io/badge/TypeScript-5-blue.svg" alt="TypeScript" />
</p>

---

## The Problem

OpenClaw webhook auth uses a **single shared gateway token**. That works for transport, but breaks down for identity-aware agent systems:

- **Shared-secret blast radius** — if one token leaks, any caller can impersonate a trusted agent until rotation
- **No per-agent identity** — receivers cannot prove which exact agent sent a request or who owns it
- **Weak revocation** — disabling one compromised agent means rotating shared credentials across all integrations
- **No local trust policy** — gateway operators cannot enforce "who is allowed" per caller identity
- **Public exposure trade-off** — for agent-to-agent communication, you need a public endpoint; without a proxy layer, that means exposing OpenClaw directly or sharing the webhook token with every caller

## What Clawdentity Does

Clawdentity works **with** OpenClaw (not a fork) and adds the missing identity layer for agent-to-agent trust:

- **Per-agent identity** — each agent gets a unique DID and registry-signed passport (AIT)
- **Request-level signing** — every request is cryptographically signed with a proof-of-possession (PoP) header
- **Instant revocation** — revoke one agent via signed CRL without rotating any shared tokens
- **Proxy enforcement** — trust-pair policies, per-agent rate limits, and replay protection at the gateway boundary
- **OpenClaw stays private** — the proxy is the only public-facing endpoint; your OpenClaw instance stays on localhost and the webhook token is never shared
- **QR-code pairing** — one-scan first-contact trust approval between agents

## How It Works

```
Caller Agent
  │
  │  Authorization: Claw <AIT>
  │  + X-Claw-Proof / Nonce / Timestamp
  ▼
Clawdentity Proxy          ← verifies identity, trust policy, rate limits
  │
  │  x-openclaw-token: <hooks.token>   (internal only)
  ▼
OpenClaw Gateway            ← localhost only, never exposed
```

1. **Provision** — create an agent identity (Ed25519 keypair + registry-issued AIT)
2. **Sign** — SDK signs every outbound request with the agent's private key
3. **Verify** — proxy validates AIT + PoP + CRL + trust pair before forwarding
4. **Forward** — only verified requests reach OpenClaw on localhost; your instance is never directly reachable from the internet

## Quick Start

Have an invite code (`clw_inv_...`) ready, then prompt your OpenClaw agent:

> Set up Clawdentity relay

The agent runs the full onboarding sequence — install, identity creation, relay configuration, and readiness checks. It will ask for your invite code and agent name.

<details>
<summary>Manual CLI setup</summary>

```bash
# Install the CLI
npm install -g clawdentity

# Initialize config
clawdentity config init

# Redeem an invite (sets API key)
clawdentity invite redeem <code> --display-name "Your Name"

# Create an agent identity
clawdentity agent create <name> --framework openclaw

# Configure the relay
clawdentity openclaw setup <name>

# Install the skill artifact
clawdentity skill install

# Verify everything works
clawdentity openclaw doctor
```

</details>

## Shared Tokens vs Clawdentity

| Property | Shared Webhook Token | Clawdentity |
|----------|---------------------|-------------|
| **Identity** | All callers look the same | Each agent has a unique DID and signed passport |
| **Blast radius** | One leak exposes everything | One compromised key only affects that agent |
| **Revocation** | Rotate shared token = break all integrations | Revoke one agent instantly via CRL, others unaffected |
| **Replay protection** | None | Timestamp + nonce + signature on every request |
| **Tamper detection** | None | Body hash + PoP signature = any modification is detectable |
| **Per-caller policy** | Not possible | Trust pairs by sender/recipient DID, rate limit per agent |
| **Key exposure** | Token must be shared with every caller | Private key never leaves the agent's machine |
| **Network exposure** | OpenClaw must be reachable by callers; token shared with each | OpenClaw stays on localhost; only the proxy is public |

## Security Highlights

- **Private keys never leave your machine** — generated and stored locally, never transmitted
- **Ed25519 + EdDSA** — modern, fast elliptic-curve cryptography
- **Per-request proof-of-possession** — every HTTP call is signed with method, path, body hash, timestamp, and nonce
- **Replay protection** — timestamp skew check + per-agent nonce cache
- **Instant revocation** — signed CRL propagation; proxy rejects revoked agents on next refresh
- **Trust pairs** — receiver operators control which agents are allowed, per-DID

## Self-Hosting

Clawdentity runs on **Cloudflare Workers** with **D1** for storage:

| Component | Role |
|-----------|------|
| **Registry** (`apps/registry`) | Issues AITs, serves public keys + CRL, manages invites |
| **Proxy** (`apps/proxy`) | Verifies identity headers, enforces trust policy, forwards to OpenClaw |

Both are Cloudflare Workers deployed with `wrangler`. See [ARCHITECTURE.md](./ARCHITECTURE.md) for full deployment instructions, environment configuration, and CI/CD setup.

## Project Structure

```
clawdentity/
├── apps/
│   ├── registry/          — Identity registry (Cloudflare Worker)
│   ├── proxy/             — Verification proxy (Cloudflare Worker)
│   ├── cli/               — Operator CLI (npm: clawdentity)
│   └── openclaw-skill/    — OpenClaw relay skill integration
├── packages/
│   ├── protocol/          — Canonical types + signing rules
│   └── sdk/               — TypeScript SDK (sign, verify, CRL, auth)
└── nx.json                — Nx monorepo orchestration
```

## Contributing

This repo uses a **deployment-first gate** tracked in [GitHub Issues](https://github.com/vrknetha/clawdentity/issues):

1. Pick an open issue and confirm dependencies/blockers.
2. Implement in a feature branch with tests.
3. Open a PR to `develop`.

## License

[MIT](./LICENSE)

## Deep Docs

- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — full protocol flows, verification pipeline, security architecture, deployment details
- **[PRD.md](./PRD.md)** — MVP product requirements and rollout strategy
