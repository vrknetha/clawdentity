# Clawdentity Architecture

Deep technical reference for Clawdentity's protocol, verification pipeline, security model, and deployment.

For an overview and quick start, see [README.md](./README.md).

---

## Table of Contents

- [Agent-to-Agent Communication: Complete Flow](#agent-to-agent-communication-complete-flow)
  - [Overview](#overview)
  - [Step 1: Human Onboarding (Invite-Gated)](#step-1-human-onboarding-invite-gated)
  - [Step 2: Agent Identity Creation (Challenge-Response)](#step-2-agent-identity-creation-challenge-response)
  - [Step 3: Peer Routing Setup](#step-3-peer-routing-setup-out-of-band-metadata)
  - [Step 4: First Message](#step-4-first-message-bob--alice)
- [Verification Pipeline](#verification-pipeline)
- [Operator Controls](#operator-controls)
- [What Gets Shared](#what-gets-shared-and-what-never-should)
- [Core Features (MVP)](#core-features-mvp)
- [Discovery Mechanisms](#discovery-how-first-contact-happens)
- [Security Architecture](#security-architecture-mvp)
- [Deployment](#deployment)
- [MVP Goals](#mvp-goals)

---

## Why This Exists (OpenClaw Reality)

OpenClaw webhooks are a great transport layer, but they authenticate using a **single shared webhook token**. OpenClaw requires `hooks.token` when hooks are enabled, and inbound calls must provide the token (e.g., `Authorization: Bearer ...` or `x-openclaw-token: ...`).
OpenClaw docs: https://docs.openclaw.ai/automation/webhook

That means "just replace Bearer with Claw" does **not** work without upstream changes.

### MVP Integration Approach (No OpenClaw Fork)

For MVP, Clawdentity runs as a **proxy/sidecar** in front of OpenClaw:

```
Caller Agent
  |
  |  Authorization: Claw <AIT>  +  X-Claw-Proof/Nonce/Timestamp
  v
Clawdentity Proxy   (verifies identity + trust policy + rate limits)
  |
  |  x-openclaw-token: <hooks.token>   (internal only)
  v
OpenClaw Gateway  (normal /hooks/agent handling)
```

**What happens to the OpenClaw hooks token?**

- It stays **private** on the gateway host.
- Only the proxy uses it to forward requests to OpenClaw.
- You never share it with other humans/agents.

---

## Agent-to-Agent Communication: Complete Flow

This section walks through **every step** from zero to two OpenClaw agents exchanging their first message. Each step adds a security guarantee that the shared-token model cannot provide.

### Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        CLAWDENTITY REGISTRY                            │
│                                                                        │
│  Issues identities (AIT) ·  Publishes revocation list (CRL)           │
│  Validates agent auth    ·  Manages invite-gated onboarding            │
└───────────────┬─────────────────────────────────┬──────────────────────┘
                │                                 │
      issues AIT + auth                  issues AIT + auth
                │                                 │
    ┌───────────▼──────────┐          ┌───────────▼──────────┐
    │     AGENT ALICE       │          │      AGENT BOB       │
    │  (OpenClaw + keys)    │          │  (OpenClaw + keys)   │
    │                       │          │                      │
    │  Ed25519 keypair      │          │  Ed25519 keypair     │
    │  AIT (signed passport)│          │  AIT (signed passport│
    │  Auth tokens          │          │  Auth tokens         │
    └───────────┬───────────┘          └──────────┬───────────┘
                │                                 │
        signs every request              signs every request
        with private key                 with private key
                │                                 │
    ┌───────────▼──────────┐          ┌───────────▼──────────┐
    │    ALICE'S PROXY      │◄─────────│   Bob sends signed   │
    │  (Cloudflare Worker)  │ HTTP POST│   request to Alice   │
    │                       │          │                      │
    │  Verifies identity    │          └──────────────────────┘
    │  Checks revocation    │
    │  Enforces trust pairs │
    │  Rejects replays      │
    │  Rate limits per agent│
    └───────────┬───────────┘
                │
        only verified requests
        reach OpenClaw
                │
    ┌───────────▼──────────┐
    │   ALICE'S OPENCLAW    │
    │  (localhost, private) │
    │                       │
    │  Receives message     │
    │  Never exposed to     │
    │  public internet      │
    └───────────────────────┘
```

### Step 1: Human Onboarding (Invite-Gated)

An admin creates an invite code. A new operator redeems it to get API access.

```
Admin                          Registry
  │                               │
  │  clawdentity invite create    │
  │──────────────────────────────►│  Generates clw_inv_<random>
  │◄──────────────────────────────│  Stores with optional expiry
  │                               │
  │  Shares invite code           │
  │  out-of-band (email, etc.)    │
  │                               │

New Operator                   Registry
  │                               │
  │  clawdentity invite redeem    │
  │──────────────────────────────►│  Creates human account
  │◄──────────────────────────────│  Issues API key (shown once)
  │                               │
  │  Stores API key locally       │
```

**Security:** Invite codes are single-use and time-limited. One agent per invite prevents bulk abuse.

### Step 2: Agent Identity Creation (Challenge-Response)

The operator creates an agent identity. The private key **never leaves the machine**.

```
CLI (operator's machine)              Registry
  │                                      │
  │  1. Generate Ed25519 keypair         │
  │     (secret.key stays local)         │
  │                                      │
  │  2. POST /v1/agents/challenge        │
  │     { publicKey }                    │
  │─────────────────────────────────────►│  Generates 24-byte nonce
  │◄─────────────────────────────────────│  Returns { challengeId,
  │                                      │    nonce, ownerDid }
  │                                      │
  │  3. Sign canonical proof with        │
  │     private key (proves ownership)   │
  │                                      │
  │  4. POST /v1/agents                  │
  │     { name, publicKey, challengeId,  │
  │       challengeSignature }           │
  │─────────────────────────────────────►│  Verifies signature
  │                                      │  Creates agent record
  │                                      │  Issues AIT (JWT, EdDSA)
  │                                      │  Issues auth tokens
  │◄─────────────────────────────────────│  Returns { agent, ait,
  │                                      │    agentAuth }
  │  Stores locally:                     │
  │    ~/.clawdentity/agents/<name>/     │
  │      ├── secret.key (private, 0600)  │
  │      ├── public.key                  │
  │      ├── ait.jwt (signed passport)   │
  │      ├── identity.json               │
  │      └── registry-auth.json          │
```

**Security:** Challenge-response proves the operator holds the private key without ever transmitting it. The 5-minute challenge window prevents delayed replay. Each challenge is single-use.

**What's in the AIT (Agent Identity Token):**

| Claim | Purpose |
|-------|---------|
| `sub` | Agent DID (`did:cdi:<authority>:agent:<ulid>`) — unique identity |
| `ownerDid` | Human DID — who owns this agent |
| `cnf.jwk.x` | Agent's public key — for verifying PoP signatures |
| `jti` | Token ID — for revocation tracking |
| `iss` | Registry URL — who vouches for this identity |
| `exp` | Expiry — credential lifetime (1-90 days) |

### Step 3: Peer Routing Setup (Out-of-Band Metadata)

Operators exchange peer metadata out-of-band (alias, DID, proxy URL). No relay invite code is required.

```
Alice's Operator                        Bob's Operator
  │                                        │
  │  POST /pair/start (proxy API)          │
  │  receives clwpair1_... ticket          │
  │────────────────────────────────────────►│
  │                                        │
  │                                        │  POST /pair/confirm (proxy API)
  │                                        │    ticket + responder metadata
  │                                        │
  │                                        │  Persists trusted peer metadata:
  │                                        │  alias + DID + proxy URL
  │                                        │
  │                                        │  Relay transform reads paired peers
```

**Security:** Setup uses only public peer metadata (DID + proxy URL + alias). No keys, tokens, or secrets are exchanged. Alice and Bob must complete proxy pairing (`/pair/start` + `/pair/confirm`) before either side can send messages.

### Step 4: First Message (Bob → Alice)

Bob's OpenClaw triggers the relay. Every request is cryptographically signed.

```
Bob's OpenClaw        relay-to-peer.ts       Alice's Proxy           Alice's OpenClaw
     │                      │                      │                       │
     │  Hook trigger:       │                      │                       │
     │  { peer: "alice",    │                      │                       │
     │    message: "Hi!" }  │                      │                       │
     │─────────────────────►│                      │                       │
     │                      │                      │                       │
     │               1. Load Bob's credentials     │                       │
     │                  (secret.key, ait.jwt)       │                       │
     │               2. Look up "alice" in          │                       │
     │                  peers.json → proxy URL      │                       │
     │               3. Sign HTTP request:          │                       │
     │                  ┌─────────────────────┐     │                       │
     │                  │ Canonical string:    │     │                       │
     │                  │ POST /hooks/agent    │     │                       │
     │                  │ timestamp:<unix>     │     │                       │
     │                  │ nonce:<random>       │     │                       │
     │                  │ body-sha256:<hash>   │     │                       │
     │                  │                     │     │                       │
     │                  │ Ed25519.sign(canon,  │     │                       │
     │                  │   secretKey) → proof │     │                       │
     │                  └─────────────────────┘     │                       │
     │               4. Send signed request:        │                       │
     │                  POST https://alice-proxy/hooks/agent                │
     │                  Authorization: Claw <ait>   │                       │
     │                  X-Claw-Timestamp: <ts>      │                       │
     │                  X-Claw-Nonce: <random>      │                       │
     │                  X-Claw-Body-SHA256: <hash>  │                       │
     │                  X-Claw-Proof: <signature>   │                       │
     │                  X-Claw-Agent-Access: <token>│                       │
     │                      │─────────────────────►│                       │
     │                      │                      │                       │
     │                      │               VERIFICATION PIPELINE          │
     │                      │               ─────────────────────          │
     │                      │               ① Verify AIT signature         │
     │                      │                 (registry EdDSA keys)        │
     │                      │               ② Check timestamp skew         │
     │                      │                 (max ±300 seconds)           │
     │                      │               ③ Verify PoP signature         │
     │                      │                 (Ed25519 from AIT cnf key)   │
     │                      │               ④ Reject nonce replay          │
     │                      │                 (per-agent nonce cache)      │
     │                      │               ⑤ Check CRL revocation         │
     │                      │                 (signed list from registry)  │
     │                      │               ⑥ Enforce trust pair           │
     │                      │                 (is Bob trusted for Alice?)  │
     │                      │               ⑦ Validate agent access token  │
     │                      │                 (POST to registry)           │
     │                      │                      │                       │
     │                      │                      │  ALL CHECKS PASSED    │
     │                      │                      │                       │
     │                      │                      │  Forward to OpenClaw:  │
     │                      │                      │  POST /hooks/agent     │
     │                      │                      │  x-openclaw-token: <t> │
     │                      │                      │──────────────────────►│
     │                      │                      │                       │  Message
     │                      │                      │◄──────────────────────│  delivered!
     │                      │◄─────────────────────│  202                  │
     │◄─────────────────────│                      │                       │
```

---

## Verification Pipeline

### What Gets Verified (and When It Fails)

| Check | Failure | HTTP Status | Meaning |
|-------|---------|-------------|---------|
| AIT signature | `PROXY_AUTH_INVALID_AIT` | 401 | Token is forged or tampered |
| Timestamp skew | `PROXY_AUTH_TIMESTAMP_SKEW` | 401 | Request is too old or clock is wrong |
| PoP signature | `PROXY_AUTH_INVALID_PROOF` | 401 | Sender doesn't hold the private key |
| Nonce replay | `PROXY_AUTH_REPLAY` | 401 | Same request was sent twice |
| CRL revocation | `PROXY_AUTH_REVOKED` | 401 | Agent identity has been revoked |
| Trust policy | `PROXY_AUTH_FORBIDDEN` | 403 | Agent is valid but not trusted for this recipient |
| Agent access token | `PROXY_AGENT_ACCESS_INVALID` | 401 | Session token expired or revoked |
| Rate limit | `PROXY_RATE_LIMIT_EXCEEDED` | 429 | Too many requests from this agent |

---

## Operator Controls

### Sender Side Operator (Owner/Admin)

- Action: registry API revoke (`DELETE /v1/agents/:id`)
- Scope: **global** (registry-level identity revocation)
- Effect: every receiving proxy rejects that revoked token once CRL refreshes.
- Use when: key compromise, decommissioning, or ownership/admin suspension events.

### Receiver Side Operator (Callee Gateway Owner)

- Action: remove/deny trusted caller pair in local proxy trust state (or keep approval-required first contact)
- Scope: **local only** (that specific gateway/proxy)
- Effect: caller is blocked on this gateway immediately, but remains valid elsewhere unless globally revoked.
- Use when: policy mismatch, abuse from a specific caller, temporary trust removal.

### Key Distinction

- **Global revoke** = sender owner/admin authority at registry.
- **Local block** = receiver operator authority at their own gateway.
- Opposite-side operator cannot globally revoke someone else's agent identity; they can only deny locally.

### Incident Response Pattern

1. Receiver blocks caller locally for immediate containment.
2. Sender owner/admin performs registry revoke for ecosystem-wide invalidation.
3. Proxies return:
   - `401` for invalid/expired/revoked identity
   - `403` for valid identity that is not trusted locally for the target recipient

---

## What Gets Shared (and What Never Should)

- Shared **in-band** on each request: **AIT + PoP proof headers**
- Shared publicly: registry signing public keys + CRL (signed, cacheable)
- **Never shared**: the agent's **private key** or identity folder

---

## Core Features (MVP)

### 1) Identity Issuance and Verification

- Handled by: `apps/registry`, `packages/sdk`
- Registry issues signed AITs tied to agent DID + owner DID.
- Registry publishes verification material (`/.well-known/claw-keys.json`) and signed CRL.
- SDK + proxy verify signatures, expiry windows, and token validity locally.

### 2) Request-Level Proof and Replay Protection

- Handled by: `packages/sdk`, `apps/proxy`
- Each request carries PoP-bound headers:
  - `Authorization: Claw <AIT>`
  - `X-Claw-Timestamp`
  - `X-Claw-Nonce`
  - `X-Claw-Body-SHA256`
  - `X-Claw-Proof`
- Proxy rejects tampered payloads, nonce replays, and stale timestamps.

### 3) Proxy Enforcement Before OpenClaw

- Handled by: `apps/proxy`
- Proxy Worker verifies AIT + CRL + PoP before forwarding to OpenClaw.
- Enforces durable trust pairs for sender/recipient DID.
- Applies per-agent rate limiting.
- Keeps `hooks.token` private and only injects it internally during forward.
- By default, `INJECT_IDENTITY_INTO_MESSAGE=true` to prepend a sanitized identity block
  (`agentDid`, `ownerDid`, `issuer`, `aitJti`) into `/hooks/agent` payload `message`.
  Set `INJECT_IDENTITY_INTO_MESSAGE=false` to keep payloads unchanged.

### 4) Operator Lifecycle Tooling (CLI)

- Handled by: `crates/clawdentity-cli`, `crates/clawdentity-core`
- `clawdentity init` + `clawdentity register` for local identity bootstrap and registry enrollment.
- `clawdentity agent create <name>` for local keypair + agent registration.
- `clawdentity agent inspect <name>` for local identity/auth state inspection.
- `clawdentity agent auth refresh <name>` / `clawdentity agent auth revoke <name>` for per-agent auth lifecycle.
- `clawdentity api-key create|list|revoke` for PAT lifecycle.
- `clawdentity install --platform <platform>` for provider artifact install/bootstrap.
- `clawdentity provider setup --for <platform> --agent-name <name>` for runtime/hook setup.
- `clawdentity provider doctor --for <platform>` and `provider relay-test --for <platform> --peer <alias>` for readiness and relay diagnostics.
- `clawdentity connector start <agentName>` and `connector service install|uninstall <agentName>` for runtime operations.

#### Connector Local OpenClaw Resilience

- Runtime probes local OpenClaw base URL reachability on an interval:
  - `CONNECTOR_OPENCLAW_PROBE_INTERVAL_MS` (default `10000`)
  - `CONNECTOR_OPENCLAW_PROBE_TIMEOUT_MS` (default `3000`)
- While probe state is down, inbound replay skips direct hook delivery attempts and keeps messages pending in the connector inbox.
- Runtime replay retries OpenClaw hook delivery with bounded backoff:
  - `CONNECTOR_RUNTIME_REPLAY_MAX_ATTEMPTS` (default `3`)
  - `CONNECTOR_RUNTIME_REPLAY_RETRY_INITIAL_DELAY_MS` (default `2000`)
  - `CONNECTOR_RUNTIME_REPLAY_RETRY_MAX_DELAY_MS` (default `8000`)
  - `CONNECTOR_RUNTIME_REPLAY_RETRY_BACKOFF_FACTOR` (default `2`)
- Hook `401/403` responses are treated as auth-rotation signals: connector re-reads `~/.clawdentity/openclaw-relay.json` and retries.
- Connector forwards structured identity headers to local OpenClaw hooks:
  - `x-clawdentity-agent-did`
  - `x-clawdentity-to-agent-did`
  - `x-clawdentity-verified`
- Connector `/v1/status` now surfaces `inbound.openclawGateway` alongside `inbound.openclawHook`.

### 5) Onboarding and Control Model

- Handled by: `apps/registry`, `crates/clawdentity-cli`
- Invite-gated registration model with admin-issued invite codes.
- One-agent-per-invite policy for simple quota and abuse control.
- Feature work follows a deployment-first gate tracked in GitHub issues.

### 6) Discovery and First-Contact Options

- Handled by: `apps/registry`, `apps/proxy`, `crates/clawdentity-cli`
- Out-of-band contact card sharing.
- Registry `gateway_hint` resolution.
- Pairing-code flow for first-contact trust approval (PAT-verified owner start + one-time confirm).

---

## OpenClaw Skill Install

Expected operator flow starts from the CLI command:

```bash
clawdentity install --for openclaw
clawdentity provider setup --for openclaw --agent-name <agent-name>
```

Installer logic prepares OpenClaw runtime artifacts automatically:
- `~/.openclaw/skills/clawdentity-openclaw-relay/SKILL.md`
- `~/.openclaw/skills/clawdentity-openclaw-relay/references/*`
- `~/.openclaw/skills/clawdentity-openclaw-relay/relay-to-peer.mjs`
- `~/.openclaw/hooks/transforms/relay-to-peer.mjs`

Install is idempotent and logs deterministic per-artifact outcomes (`installed`, `updated`, `unchanged`).
The Rust binary installs embedded OpenClaw skill assets so clean installs do not depend on npm packages at runtime.

### CLI Rust Release (Manual)

- GitHub workflow: `.github/workflows/publish-rust.yml`
- Trigger: `workflow_dispatch` with semver release inputs
- Publish target: crates.io for Rust crates plus R2/GitHub release assets for the `clawdentity` binary
- Workflow runs release verification, checksum generation, installer smoke tests, and skill-asset parity checks before publishing.

---

## Discovery (How First Contact Happens)

MVP supports three ways to "find" another agent:

1. **Out-of-band share**: human shares a contact card (verify link + endpoint URL)
2. **Registry `gateway_hint`**: callee publishes an endpoint, callers resolve it via registry
3. **Pairing code** (proxy): "Approve first contact" to establish a mutual trusted agent pair

No one shares keys/files between agents. Identity is presented per request.

---

## Security Architecture (MVP)

### Trust Boundaries and Sensitive Assets

- **Agent private key**: secret, local only, never leaves agent machine.
- **Registry signing key**: secret, server-side only, signs AIT and CRL.
- **OpenClaw `hooks.token`**: secret, only present on gateway host/proxy.
- **AIT + PoP headers**: transmitted per request, safe to share in-band.

### Threats Addressed

- Do not expose OpenClaw webhooks directly to the public internet. Follow OpenClaw guidance (loopback, tailnet, trusted reverse proxy).
  Docs: https://docs.openclaw.ai/automation/webhook
- Clawdentity PoP signatures must bind:
  - method, path, timestamp, nonce, body hash
  - and reject nonce replays
- Reject tampering: any change to method/path/body/timestamp/nonce invalidates proof.
- Reject unauthorized callers: AIT verification + trust-pair enforcement.
- Reject compromised identities quickly: CRL-based revocation checks.
- Contain abuse: per-agent rate limits at proxy boundary.

### Security Guarantees and Limits

- Guarantees:
  - caller identity can be cryptographically verified
  - caller ownership is traceable via token claims
  - revocation can be enforced without rotating shared OpenClaw token
- Limits:
  - if the endpoint that holds the agent private key is compromised, attacker can sign as that agent until revocation
  - if CRL refresh is delayed, enforcement follows configured staleness policy (`fail-open` or `fail-closed`)

### Safe Defaults and Operator Guidance

- Treat any identity fields (agent name/description) as untrusted input; never allow prompt injection via identity metadata.
- Keep OpenClaw behind trusted network boundaries; expose only proxy entry points.
- Rotate PATs and audit trusted pair entries regularly.
- Store PATs in secure local config only; create responses return token once and it cannot be retrieved later from the registry.
- Rotation baseline: keep one primary key + one standby key, rotate at least every 90 days, and revoke stale keys immediately after rollout.

---

## Deployment

### Repo Layout

Nx monorepo with pnpm workspaces:

```
clawdentity/
├── apps/
│   ├── registry/          — Identity registry (Cloudflare Worker)
│   │                        Issues AITs, serves CRL + public keys
│   │                        Worker config: apps/registry/wrangler.jsonc
│   ├── proxy/             — Verification proxy (Cloudflare Worker)
│   │                        Verifies Clawdentity headers, forwards to OpenClaw
│   │                        Worker config: apps/proxy/wrangler.jsonc
│   ├── cli/               — Operator CLI
│   │                        Agent create/revoke, invite, api-key, config
│   └── openclaw-skill/    — OpenClaw skill integration
│                            Relay transform for agent-to-agent messaging
├── packages/
│   ├── protocol/          — Canonical types + signing rules
│   │                        AIT claims, DID format, HTTP signing, endpoints
│   └── sdk/               — TypeScript SDK
│                            Sign/verify, CRL cache, auth client, crypto
└── Configuration
    ├── nx.json            — Monorepo task orchestration
    ├── pnpm-workspace.yaml
    └── tsconfig.base.json
```

### Proxy Worker Local Runs

- Development env (`ENVIRONMENT=development`): `pnpm dev:proxy`
- Local env (`ENVIRONMENT=local`): `pnpm dev:proxy:local`
- Fresh deploy-like env: `pnpm dev:proxy:fresh`
- Development deploy command: `pnpm -F @clawdentity/proxy run deploy:dev`
- Production deploy command: `pnpm -F @clawdentity/proxy run deploy:production`
- Environment intent: `local` is local Wrangler development only; `development` and `production` are cloud deployment environments.

### Registry Worker Local Runs

- Development env (`ENVIRONMENT=development`): `pnpm dev:registry`
- Development env with local D1 migration apply: `pnpm dev:registry:local`

### Deploy Automation

- GitHub workflow: `.github/workflows/deploy-develop.yml`
- Trigger: push to `develop`
- Runs full quality gates, then deploys:
  - registry (`apps/registry`, env `dev`) with D1 migrations
  - proxy (`apps/proxy`, env `dev`)
- Health checks must pass with `version == $GITHUB_SHA` for:
  - `https://dev.registry.clawdentity.com/health`
  - deployed proxy `/health` URL (workers.dev URL extracted from wrangler output, or optional `PROXY_HEALTH_URL` secret override)
- Required GitHub secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`

---

## MVP Goals

1. **Create agent identity** (local keypair + registry-issued AIT)
2. **Send signed requests** (PoP per request, replay-resistant)
3. **Verify locally** (signature + expiry + cached CRL)
4. **Kill switch** (revoke → proxy rejects within CRL refresh window)
5. **Discovery** (share endpoint + verify link; optional pairing code)

---

## Further Reading

- **[README.md](./README.md)** — overview, quick start, and comparison
- **Execution and issue governance:** [GitHub issue tracker](https://github.com/vrknetha/clawdentity/issues/74)
