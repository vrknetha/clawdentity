# PRD — Clawdentity MVP (v0.1)

**Last updated:** 2026-02-11  
**Owner:** Ravi Kiran Vemula  
**Status:** Ready for execution (deployment-first gate enabled)  
**Primary target:** OpenClaw Gateway webhooks (`/hooks/*`)  
**OpenClaw docs reference:** https://docs.openclaw.ai/automation/webhook

---

## 1) Problem

OpenClaw webhooks are authenticated via a **single shared webhook token** (`hooks.token`). When hooks are enabled, OpenClaw requires this token on inbound requests (e.g., `Authorization: Bearer <token>` or `x-openclaw-token: <token>`). This creates:

- **No identity:** receiver can’t prove which agent called
- **No accountability:** can’t answer “who owns this agent?”
- **No kill switch:** compromise persists unless token rotated everywhere

---

## 2) Goal (MVP)

Deliver a minimal identity layer that answers:

> “Who is this agent, who owns it, and is it revoked?”

…and make it work with OpenClaw **without forking OpenClaw**.

---

## 3) MVP approach (OpenClaw-aligned)

Because OpenClaw requires `hooks.token` and expects Bearer/token auth for `/hooks/*`, MVP uses a **Clawdentity Proxy** in front of OpenClaw:

- External callers authenticate to the proxy using **Clawdentity identity headers**
- Proxy verifies identity locally (AIT signature + expiry + cached CRL + PoP)
- Proxy forwards the request to OpenClaw with `x-openclaw-token: <hooks.token>`

**Important:** The OpenClaw webhook token is never shared externally.

---

## 4) Users

### Personas
1) **Gateway Operator:** runs OpenClaw; wants to allow only verified callers
2) **Agent Developer:** needs simple tooling to sign outbound calls
3) **Relying-party Service:** wants local verification + revocation checks

---

## 5) Scope

### In scope (MVP)
- **Registry**
  - Create agent identity: register public key, issue AIT
  - Cloudflare Worker runtime config lives at `apps/registry/wrangler.jsonc`
  - Publish registry signing public keys (`/.well-known/claw-keys.json`)
  - Revoke agent → CRL
  - CRL endpoint (signed)
  - Optional: `gateway_hint` storage + public resolve

- **SDK (TypeScript)**
  - Generate/load agent keypair
  - Sign requests (PoP) with replay protection
  - Verify AIT (offline signature verification)
  - CRL caching & revocation checks

- **CLI**
  - Create agent (`claw agent create`)
  - Revoke agent (`claw agent revoke`)
  - Inspect token (`claw agent inspect`)
  - Verify token (`claw verify`)
  - Share contact card (`claw share`)

- **Proxy**
  - Verify inbound Clawdentity headers
  - Enforce allowlist rules (agent DID only in current phase; owner DID support deferred)
  - Rate-limit per verified agent DID
  - Forward to OpenClaw `/hooks/agent` with `x-openclaw-token`

- **Discovery**
  - Share-by-contact-card (verify link + endpoint)
  - Resolve `gateway_hint` from registry (optional)
  - Pairing code (optional, “approve first contact”)

- **Onboarding / access control**
  - Invite-gated user registration (`register --invite`)
  - One agent slot per invite code
  - Admin invite management workflow

### Out of scope (MVP)
- Organizations, org roles
- Public search discovery (`/discover?q=`), badges
- WebSocket revocation push (polling only)
- Permissions/scopes/delegation chains
- “Immutable signed audit log” claims

---

## 6) Functional requirements

### 6.1 AIT (Agent Identity Token)
- JWT (JWS), `alg=EdDSA`, `typ=AIT`
- Payload must include:
  - `iss`, `sub` (agent DID), `owner` (human DID)
  - `agent_pubkey` or `cnf`
  - `iat`, `nbf`, `exp`, `jti`
  - `name` (strict validation), `framework`
- **One active AIT per agent DID**
  - Reissue/rotate automatically revokes the previous `jti`

### 6.2 CRL (Revocation List)
- Signed token (JWT JWS), `typ=CRL`
- Contains list of revoked `jti`s (+ metadata)
- Clients cache and refresh at default **300 seconds**
- Configurable stale behavior: fail-open vs fail-closed

### 6.3 PoP request signing (replay-resistant)
Headers required:
- `Authorization: Claw <AIT>`
- `X-Claw-Timestamp: <unix seconds>`
- `X-Claw-Nonce: <base64url random>`
- `X-Claw-Body-SHA256: <base64url sha256(raw body)>`
- `X-Claw-Proof: <signature over canonical string>`

Verifier must enforce:
- timestamp max skew (default 300s)
- nonce replay cache (default 5 minutes)
- proof signature verifies against pubkey in AIT
- reject if AIT is revoked

### 6.4 Proxy → OpenClaw forwarding
- Proxy forwards to `${openclawBaseUrl}/hooks/agent`
- Adds OpenClaw hook token internally:
  - `x-openclaw-token: <hooks.token>`

### 6.5 OpenClaw behavioral constraints
- `/hooks/agent` is async and returns **202** (job started)
- Multi-turn continuity uses `sessionKey` field

### 6.6 Invite-gated user model
- Bootstrap creates the first admin + PAT
- Admin creates invite codes with optional expiry
- Registration requires a valid invite code
- One invite maps to one agent slot
- Admin may suspend a human, which triggers agent revocation flow

---

## 7) Non-functional requirements

- **Setup time:** < 10 minutes to first verified call
- **Propagation:** revocation enforced within CRL refresh window
- **Reliability:** verifier works when registry is temporarily unavailable (uses cached keys/CRL)
- **Security:** replay protection must be implemented (nonce + cache)

---

## 8) Success criteria

- Valid caller → proxy forwards → OpenClaw returns 202
- Invalid/expired/revoked token → proxy returns 401
- Valid but not allowlisted → proxy returns 403
- Replay within time window is rejected (nonce reuse)
- Revocation causes rejection within next CRL refresh

---

## 9) Rollout plan

1) **Scaffold baseline (`T00`)**
2) **Define deployment scaffolding (`T37`)**
3) **Deploy and verify baseline (`T38`)**
4) Implement feature backlog (`T01`-`T36`) after deploy gate passes
5) Execute Phase 2/3 enhancements from HLD after MVP stability

---

## 10) Execution plan

Execution plan is defined in [`issues/EXECUTION_PLAN.md`](./issues/EXECUTION_PLAN.md).

### Canonical sequential order
`T00 -> T37 -> T38 -> T01 -> T02 -> T03 -> T04 -> T05 -> T06 -> T07 -> T08 -> T09 -> T10 -> T11 -> T12 -> T13 -> T14 -> T15 -> T16 -> T17 -> T18 -> T19 -> T20 -> T21 -> T22 -> T23 -> T24 -> T25 -> T26 -> T27 -> T28 -> T29 -> T30 -> T31 -> T32 -> T33 -> T34 -> T35 -> T36`

### Parallel waves (after deployment gate)
- Wave 0: `T00`
- Wave 1: `T37`
- Wave 2: `T38`
- Wave 3: `T01, T10, T20, T25`
- Wave 4: `T02, T03, T04, T11, T26`
- Wave 5: `T05, T06, T07, T12, T13, T19`
- Wave 6: `T08, T09, T14, T15, T22`
- Wave 7: `T16, T21, T24, T27, T34`
- Wave 8: `T17, T18, T23, T28, T30, T31, T32, T35`
- Wave 9: `T29, T36`
- Wave 10: `T33`

### Issue governance
Issue authoring and quality rules are enforced in [`issues/AGENTS.md`](./issues/AGENTS.md):
- standardized schema for each ticket
- dependency blockers line required
- refactor opportunities required
- validation commands required

---

## 11) Deferred items (post-MVP)

- Web UI for revocation operations
- Pairing flow automation beyond base implementation
- Outbound relay and contact book
- Conversation threading headers (`X-Claw-Conversation-Id`, `X-Claw-Reply-To`)
- OpenClaw skill and optional first-class agent channel

---

## 12) Verification plan

1) Unit tests for protocol helpers, SDK crypto, JWT handling, nonce cache, CRL cache  
2) Integration tests for registry routes (Workers emulator) and proxy pipeline  
3) E2E flow: CLI create -> signed call -> proxy verify -> OpenClaw `202`  
4) Revocation propagation test within CRL refresh window  
5) Replay attack rejection via nonce reuse checks  
6) CI gate: lint -> typecheck -> test -> build
