# Clawdentity

Verified identity + revocation for AI agents — starting with **OpenClaw**.

Clawdentity solves one question for agent-to-agent / agent-to-service calls:

> **“Who is this agent, who owns it, and is it revoked?”**

It does this with:

- **AIT (Agent Identity Token)**: a registry-signed passport (JWT / EdDSA)
- **PoP (Proof-of-Possession)**: every request is signed with the agent’s private key
- **CRL (Revocation List)**: a signed revocation feed clients cache and refresh

---

## Problem statement

OpenClaw webhook auth is built around a shared gateway token. That works for transport, but not for identity-aware agent systems.
In practice, identity is flat: any caller with the shared token looks the same to the gateway.

Current pain points:

- **Shared-secret blast radius:** if one token leaks, any caller can impersonate a trusted agent until rotation.
- **No per-agent identity:** receivers cannot prove which exact agent sent a request or who owns it.
- **Weak revocation model:** disabling one compromised agent means rotating shared credentials across integrations.
- **No local trust policy:** gateway operators cannot reliably enforce “who is allowed” per caller identity.

What Clawdentity adds:

- Verifiable per-agent identity (AIT + PoP)
- Fast revocation propagation (signed CRL + cache refresh)
- Proxy-side policy enforcement (allowlist + rate limits + replay protection)

---

## Why this exists (OpenClaw reality)

OpenClaw webhooks are a great transport layer, but they authenticate using a **single shared webhook token**. OpenClaw requires `hooks.token` when hooks are enabled, and inbound calls must provide the token (e.g., `Authorization: Bearer ...` or `x-openclaw-token: ...`).  
OpenClaw docs: https://docs.openclaw.ai/automation/webhook

That means “just replace Bearer with Claw” does **not** work without upstream changes.

### MVP integration approach (no OpenClaw fork)

For MVP, Clawdentity runs as a **proxy/sidecar** in front of OpenClaw:

```
Caller Agent
  |
  |  Authorization: Claw <AIT>  +  X-Claw-Proof/Nonce/Timestamp
  v
Clawdentity Proxy   (verifies identity + allowlist + rate limits)
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

## How it works (end-to-end)

### 1) Agent identity provisioning

- Operator runs CLI to create an agent identity.
- Registry stores the public key and issues a signed AIT.
- Agent keeps private key locally; registry never sees it.

### 2) Outbound request signing

- SDK creates PoP headers for each request:
  - `Authorization: Claw <AIT>`
  - `X-Claw-Timestamp`
  - `X-Claw-Nonce`
  - `X-Claw-Body-SHA256`
  - `X-Claw-Proof`
- Proof signature is bound to method, path, timestamp, nonce, and body hash.

### 3) Proxy verification pipeline

- Proxy validates AIT signature against registry keys.
- Proxy checks AIT expiry and CRL revocation status.
- Proxy verifies PoP signature against the key in the token.
- Proxy rejects replay via timestamp skew + nonce cache.
- Proxy enforces allowlist and rate limits.

### 4) Forward to OpenClaw

- Only verified and authorized requests are forwarded.
- Proxy injects internal `x-openclaw-token` to call OpenClaw `/hooks/agent`.
- OpenClaw continues normal processing and returns `202` for async handling.

### 5) Revocation flow

- Agent owner or admin revokes an agent at the registry.
- Registry publishes revocation in signed CRL.
- Proxy cache refresh picks up revocation and starts rejecting requests from revoked AITs.

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
    │  Enforces allowlist   │
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
| `sub` | Agent DID (`did:claw:agent:<ulid>`) — unique identity |
| `ownerDid` | Human DID — who owns this agent |
| `cnf.jwk.x` | Agent's public key — for verifying PoP signatures |
| `jti` | Token ID — for revocation tracking |
| `iss` | Registry URL — who vouches for this identity |
| `exp` | Expiry — credential lifetime (1-90 days) |

### Step 3: Peer Discovery (Out-of-Band Invite)

Alice creates an invite code for Bob. No secrets are exchanged — only a DID and endpoint.

```
Alice's Operator                        Bob's Operator
  │                                        │
  │  clawdentity openclaw invite create    │
  │  → Encodes: {                          │
  │      did: "did:claw:agent:...",        │
  │      proxyUrl: "https://alice-proxy/   │
  │        hooks/agent",                   │
  │      alias: "bob",                     │
  │      name: "Bob Agent"                 │
  │    }                                   │
  │  → Base64url invite code               │
  │                                        │
  │  Shares code out-of-band ─────────────►│
  │  (email, QR, chat, etc.)               │
  │                                        │
  │                                        │  clawdentity openclaw setup
  │                                        │    bob --invite-code <code>
  │                                        │
  │                                        │  Stores peer in peers.json:
  │                                        │  { "alice": {
  │                                        │      "did": "did:claw:agent:...",
  │                                        │      "proxyUrl": "https://..."
  │                                        │  }}
  │                                        │
  │                                        │  Installs relay transform
  │                                        │  Configures OpenClaw hooks
```

**Security:** The invite contains only public information (DID + proxy URL). No keys, tokens, or secrets are exchanged. Alice's operator must also add Bob's DID to the proxy allowlist before Bob can actually send messages.

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
     │                      │               ⑥ Enforce allowlist            │
     │                      │                 (is Bob's DID permitted?)    │
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

### Why This Beats Shared Tokens

| Property | Shared Webhook Token | Clawdentity |
|----------|---------------------|-------------|
| **Identity** | All callers look the same | Each agent has a unique DID and signed passport |
| **Accountability** | Cannot trace who sent what | Every request proves exactly which agent sent it |
| **Blast radius** | One leak exposes everything | One compromised key only affects that agent |
| **Revocation** | Rotate shared token = break all integrations | Revoke one agent instantly via CRL, others unaffected |
| **Replay protection** | None | Timestamp + nonce + signature on every request |
| **Tamper detection** | None | Body hash + PoP signature = any modification is detectable |
| **Per-caller policy** | Not possible | Allowlist by agent DID, rate limit per agent |
| **Key exposure** | Token must be shared with every caller | Private key never leaves the agent's machine |

### What Gets Verified (and When It Fails)

| Check | Failure | HTTP Status | Meaning |
|-------|---------|-------------|---------|
| AIT signature | `PROXY_AUTH_INVALID_AIT` | 401 | Token is forged or tampered |
| Timestamp skew | `PROXY_AUTH_TIMESTAMP_SKEW` | 401 | Request is too old or clock is wrong |
| PoP signature | `PROXY_AUTH_INVALID_PROOF` | 401 | Sender doesn't hold the private key |
| Nonce replay | `PROXY_AUTH_REPLAY` | 401 | Same request was sent twice |
| CRL revocation | `PROXY_AUTH_REVOKED` | 401 | Agent identity has been revoked |
| Allowlist | `PROXY_AUTH_FORBIDDEN` | 403 | Agent is valid but not authorized here |
| Agent access token | `PROXY_AGENT_ACCESS_INVALID` | 401 | Session token expired or revoked |
| Rate limit | `PROXY_RATE_LIMIT_EXCEEDED` | 429 | Too many requests from this agent |

---

## Operator controls on both ends

### Sender side operator (owner/admin)

- Action: `clawdentity agent revoke <agent>`
- Scope: **global** (registry-level identity revocation)
- Effect: every receiving proxy rejects that revoked token once CRL refreshes.
- Use when: key compromise, decommissioning, or ownership/admin suspension events.

### Receiver side operator (callee gateway owner)

- Action: remove/deny caller in local allowlist (or keep `approvalRequired` for first contact)
- Scope: **local only** (that specific gateway/proxy)
- Effect: caller is blocked on this gateway immediately, but remains valid elsewhere unless globally revoked.
- Use when: policy mismatch, abuse from a specific caller, temporary trust removal.

### Key distinction

- **Global revoke** = sender owner/admin authority at registry.
- **Local block** = receiver operator authority at their own gateway.
- Opposite-side operator cannot globally revoke someone else's agent identity; they can only deny locally.

### Incident response pattern

1. Receiver blocks caller locally for immediate containment.
2. Sender owner/admin performs registry revoke for ecosystem-wide invalidation.
3. Proxies return:
   - `401` for invalid/expired/revoked identity
   - `403` for valid identity that is not allowlisted locally

---

## What gets shared (and what never should)

- ✅ Shared **in-band** on each request: **AIT + PoP proof headers**
- ✅ Shared publicly: registry signing public keys + CRL (signed, cacheable)
- ❌ Never shared: the agent’s **private key** or identity folder

---

## Repo layout

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

---

## Core features (MVP)

### 1) Identity issuance and verification

- Handled by: `apps/registry`, `packages/sdk`
- Registry issues signed AITs tied to agent DID + owner DID.
- Registry publishes verification material (`/.well-known/claw-keys.json`) and signed CRL.
- SDK + proxy verify signatures, expiry windows, and token validity locally.

### 2) Request-level proof and replay protection

- Handled by: `packages/sdk`, `apps/proxy`
- Each request carries PoP-bound headers:
  - `Authorization: Claw <AIT>`
  - `X-Claw-Timestamp`
  - `X-Claw-Nonce`
  - `X-Claw-Body-SHA256`
  - `X-Claw-Proof`
- Proxy rejects tampered payloads, nonce replays, and stale timestamps.

### 3) Proxy enforcement before OpenClaw

- Handled by: `apps/proxy`
- Proxy Worker verifies AIT + CRL + PoP before forwarding to OpenClaw.
- Enforces caller allowlist policy by DID.
- Applies per-agent rate limiting.
- Keeps `hooks.token` private and only injects it internally during forward.
- By default, `INJECT_IDENTITY_INTO_MESSAGE=true` to prepend a sanitized identity block
  (`agentDid`, `ownerDid`, `issuer`, `aitJti`) into `/hooks/agent` payload `message`.
  Set `INJECT_IDENTITY_INTO_MESSAGE=false` to keep payloads unchanged.

### Proxy Worker local runs

- Local env (`ENVIRONMENT=local`): `pnpm dev:proxy`
- Development env (`ENVIRONMENT=development`): `pnpm dev:proxy:development`
- Fresh deploy-like env: `pnpm dev:proxy:fresh`
- Production deploy command: `pnpm -F @clawdentity/proxy run deploy:production`
- Environment intent: `local` is local Wrangler development only; `development` and `production` are cloud deployment environments.

### 4) Operator lifecycle tooling (CLI)

- Handled by: `apps/cli`
- `clawdentity agent create` for local keypair + registry registration.
- `clawdentity agent inspect` and `clawdentity verify` for offline token checks.
- `clawdentity agent revoke` for kill switch workflows.
- `clawdentity api-key create` to mint a new PAT (token shown once).
- `clawdentity api-key list` to view PAT metadata (`id`, `name`, `status`, `createdAt`, `lastUsedAt`).
- `clawdentity api-key revoke <id>` to invalidate a PAT without rotating unrelated keys.
- `clawdentity share` for contact-card exchange (DID, verify URL, endpoint).
- `clawdentity connector start <agentName>` to run local relay connector runtime.
- `clawdentity connector service install <agentName>` to configure connector autostart after reboot/login (`launchd` on macOS, `systemd --user` on Linux).
- `clawdentity connector service uninstall <agentName>` to remove connector autostart service.

### 5) Onboarding and control model

- Handled by: `apps/registry`, `apps/cli`
- Invite-gated registration model with admin-issued invite codes.
- One-agent-per-invite policy for simple quota and abuse control.
- Feature work follows a deployment-first gate tracked in GitHub issues.

### 6) Discovery and first-contact options

- Handled by: `apps/registry`, `apps/proxy`, `apps/cli`
- Out-of-band contact card sharing.
- Registry `gateway_hint` resolution.
- Optional pairing-code flow for first-contact allowlist approval.

---

## OpenClaw skill install (npm-first)

Expected operator flow starts from npm:

```bash
npm install clawdentity --skill
```

When `--skill` mode is detected, installer logic prepares OpenClaw runtime artifacts automatically:
- `~/.openclaw/workspace/skills/clawdentity-openclaw-relay/SKILL.md`
- `~/.openclaw/workspace/skills/clawdentity-openclaw-relay/references/*`
- `~/.openclaw/workspace/skills/clawdentity-openclaw-relay/relay-to-peer.mjs`
- `~/.openclaw/hooks/transforms/relay-to-peer.mjs`

Install is idempotent and logs deterministic per-artifact outcomes (`installed`, `updated`, `unchanged`).
The CLI package ships bundled skill assets so clean installs do not depend on a separate `@clawdentity/openclaw-skill` package at runtime.

### Docker E2E relay check (skill + invite flow)

For user-like OpenClaw relay validation with existing Docker agents, run:

```bash
pnpm -F @clawdentity/cli run test:e2e:openclaw-docker
```

Defaults target:
- `clawdbot-agent-alpha-1` (`http://127.0.0.1:18789`)
- `clawdbot-agent-beta-1` (`http://127.0.0.1:19001`)

This script validates:
- invite-code onboarding setup in both containers
- skill-created artifact presence
- bidirectional multi-message relay
- edge cases: unknown peer alias, connector offline, connector recovery

Common environment overrides:
- `CLAWDENTITY_E2E_PAT` (required if registry is already bootstrapped)
- `RESET_MODE=skill|full|none` (default `skill`)
- `ALPHA_CONTAINER`, `BETA_CONTAINER`
- `REGISTRY_URL`, `PROXY_HOOK_URL`, `PROXY_WS_URL`

---

## MVP goals

1. **Create agent identity** (local keypair + registry-issued AIT)
2. **Send signed requests** (PoP per request, replay-resistant)
3. **Verify locally** (signature + expiry + cached CRL)
4. **Kill switch** (revoke → proxy rejects within CRL refresh window)
5. **Discovery** (share endpoint + verify link; optional pairing code)

---

## Discovery (how first contact happens)

MVP supports three ways to “find” another agent:

1. **Out-of-band share**: human shares a contact card (verify link + endpoint URL)
2. **Registry `gateway_hint`**: callee publishes an endpoint, callers resolve it via registry
3. **Pairing code** (proxy): “Approve first contact” to auto-add caller to allowlist

No one shares keys/files between agents. Identity is presented per request.

---

## Security architecture (MVP)

### Trust boundaries and sensitive assets

- **Agent private key**: secret, local only, never leaves agent machine.
- **Registry signing key**: secret, server-side only, signs AIT and CRL.
- **OpenClaw `hooks.token`**: secret, only present on gateway host/proxy.
- **AIT + PoP headers**: transmitted per request, safe to share in-band.

### Threats addressed

- Do not expose OpenClaw webhooks directly to the public internet. Follow OpenClaw guidance (loopback, tailnet, trusted reverse proxy).  
  Docs: https://docs.openclaw.ai/automation/webhook
- Clawdentity PoP signatures must bind:
  - method, path, timestamp, nonce, body hash
  - and reject nonce replays
- Reject tampering: any change to method/path/body/timestamp/nonce invalidates proof.
- Reject unauthorized callers: AIT verification + allowlist enforcement.
- Reject compromised identities quickly: CRL-based revocation checks.
- Contain abuse: per-agent rate limits at proxy boundary.

### Security guarantees and limits

- Guarantees:
  - caller identity can be cryptographically verified
  - caller ownership is traceable via token claims
  - revocation can be enforced without rotating shared OpenClaw token
- Limits:
  - if the endpoint that holds the agent private key is compromised, attacker can sign as that agent until revocation
  - if CRL refresh is delayed, enforcement follows configured staleness policy (`fail-open` or `fail-closed`)

### Safe defaults and operator guidance

- Treat any identity fields (agent name/description) as untrusted input; never allow prompt injection via identity metadata.
- Keep OpenClaw behind trusted network boundaries; expose only proxy entry points.
- Rotate PATs and audit allowlist entries regularly.
- Store PATs in secure local config only; create responses return token once and it cannot be retrieved later from the registry.
- Rotation baseline: keep one primary key + one standby key, rotate at least every 90 days, and revoke stale keys immediately after rollout.

---

## Documentation

- **PRD:** see [`PRD.md`](./PRD.md) (MVP product requirements + rollout strategy)
- **Execution and issue governance source of truth:** GitHub issue tracker, starting at https://github.com/vrknetha/clawdentity/issues/74.

---

## Contributing / Execution

This repo is delivered through small GitHub issues with a **deployment-first gate**:

1. Pick an active GitHub issue and confirm dependencies/blockers in the tracker.
2. Implement in a feature branch with tests/docs updates.
3. Run required validation commands.
4. Open a PR to `develop` and post implementation evidence back on the issue.

### Governance expectations

- Keep issue status aligned with reality (`OPEN` while active, close with evidence when complete).
- Use GitHub issues as the only source of truth for order, dependencies, and waves.
- If rollout sequencing changes, update both tracker issues and docs in the same change.

---

## License

TBD.
