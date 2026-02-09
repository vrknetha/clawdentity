# Clawdentity 🦞🔐

**Agent Identity Protocol — SSO for AI Agents**

> Every app has SSO. Your agents have nothing. Until now.

Clawdentity is a hybrid centralized-registry / decentralized-verification identity layer for AI agents. It solves the "who are you and who sent you?" problem for the agentic era.

## The Problem

Thousands of AI agents (OpenClaw, CrewAI, LangGraph, AutoGPT) are running across the internet with **zero way to prove identity** to each other or external services. No birth certificate. No passport. No verification.

## The Solution

**Think: Google SSO, but for agents.**

1. **Human registers** → proves identity (GitHub/Google OAuth)
2. **Human mints agent identity** → agent gets a cryptographic passport (AIT)
3. **Agent proves identity anywhere** → local verification, no network call needed

## Architecture

```
Centralized Registry        Decentralized Verification
(registration, revocation)  (99% of interactions)
        ↓                           ↓
   Human signs up            Agent carries signed token
   Agent minted              Verified locally (like SSL)
   Keys rotated              No registry call needed
   Revocation broadcast      CRL cached + refreshed
```

## Key Features

- 🔑 **Cryptographic Identity** — Ed25519 keypairs, signed Agent Identity Tokens
- 👤 **Human-Anchored** — every agent chains to a verified human owner
- 🔄 **Delegation Chains** — agents can delegate scoped-down identity to sub-agents
- 🚫 **Kill Switch** — revoke an agent from your phone, dead everywhere instantly
- 🔍 **Agent Discovery** — find agents by capability, scope, framework
- 📋 **Audit Trail** — every interaction logged and verifiable
- 🔌 **Framework Agnostic** — OpenClaw first, then CrewAI, LangGraph, AutoGPT

## Quick Start

```bash
# Install CLI
npm install -g @clawdentity/cli

# Login
clawdentity login

# Create agent identity
clawdentity agent create "Kai" --scope "content.write,email.send,web.search"

# Verify another agent
clawdentity verify <agent-identity-token>
```

## Links

- 🌐 **Website:** [clawdentity.com](https://clawdentity.com)
- 📖 **Spec:** See [#1 — Full Specification](../../issues/1)
- 🦞 **OpenClaw:** [openclaw.ai](https://openclaw.ai)

## Status

🚧 **Pre-alpha** — Specification complete, implementation starting.

## License

MIT
