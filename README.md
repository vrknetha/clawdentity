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

## Repo layout (planned MVP)

This repo is a monorepo:

- `apps/registry` — issues AITs, serves CRL + public keys (Worker config: `apps/registry/wrangler.jsonc`)
- `apps/proxy` — verifies Clawdentity headers then forwards to OpenClaw hooks (Worker config: `apps/proxy/wrangler.jsonc`)
- `apps/cli` — operator workflow (`claw create`, `claw revoke`, `claw share`)
- `packages/sdk` — TS SDK (sign + verify + CRL cache)
- `packages/protocol` — shared types + canonical signing rules

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
- Optional: set `INJECT_IDENTITY_INTO_MESSAGE=true` to prepend a sanitized identity block
  (`agentDid`, `ownerDid`, `issuer`, `aitJti`) into `/hooks/agent` payload `message`.
  Default is `false`, which keeps payloads unchanged.

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
- `clawdentity share` for contact-card exchange (DID, verify URL, endpoint).

### 5) Onboarding and control model

- Handled by: `apps/registry`, `apps/cli`
- Invite-gated registration model with admin-issued invite codes.
- One-agent-per-invite policy for simple quota and abuse control.
- Feature work is deployment-gated (`T00 -> T37 -> T38`) before backlog execution.

### 6) Discovery and first-contact options

- Handled by: `apps/registry`, `apps/proxy`, `apps/cli`
- Out-of-band contact card sharing.
- Registry `gateway_hint` resolution.
- Optional pairing-code flow for first-contact allowlist approval.

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

---

## Documentation

- **PRD:** see [`PRD.md`](./PRD.md) (MVP product requirements + execution plan)
- **Issue execution plan:** see [`issues/EXECUTION_PLAN.md`](./issues/EXECUTION_PLAN.md) (deployment-first ordering + waves)
- **Issue authoring rules:** see [`issues/AGENTS.md`](./issues/AGENTS.md) (required issue schema + blockers policy)
- **Canonical ticket specs:** `issues/T00.md` through `issues/T38.md` are versioned in-repo.

---

## Contributing / Execution

This repo is built as a sequence of small issues with a **deployment-first gate**:

1. `T00` — workspace scaffolding
2. `T37` — deployment scaffolding contract
3. `T38` — baseline deployment verification
4. `T01`–`T36` — feature implementation after deploy gate passes

### Backlog shape

- Total issue set: `T00`–`T38`
- Feature tickets `T01`–`T36` explicitly depend on `T38`
- Parallel execution starts only after Wave 2 (`T38`) completes

### Issue schema

Every issue in [`issues/`](./issues) is standardized to include:

- `Goal`
- `In Scope`
- `Out of Scope`
- `Dependencies` + `Blockers`
- `Execution Mode`
- `Parallel Wave`
- `Required Skills`
- `Deliverables`
- `Refactor Opportunities`
- `Definition of Done`
- `Validation Steps`

---

## License

TBD.
