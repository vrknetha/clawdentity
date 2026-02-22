# Clawdentity Rust CLI Implementation Plan (Revalidated)

## Context
- Repository: `/Users/ravikiranvemula/Workdir/clawdentity`
- Rust sources reviewed: `crates/clawdentity-core/src/*`, `crates/clawdentity-cli/src/main.rs`
- TypeScript behavior reference reviewed: `apps/cli/src/**`, `packages/connector/src/**`
- Goal of this update: correct schema assumptions, dependency choices, and missing module coverage before coding phases 3-10.

## Critical Corrections From TS Parity Review

1. Identity/config baseline in current Rust scaffolding is not TS-parity yet.
- TS uses `~/.clawdentity` as the CLI config root.
- TS DID format is `did:claw:{human|agent}:<ULID>`, not `did:cdi:<host>:<ULID>`.
- TS registry defaults and endpoints are `clawdentity` contracts.

2. Agent registration/auth contracts are different from the current Rust assumptions.
- TS flow is challenge-based: `POST /v1/agents/challenge` then `POST /v1/agents` with canonical proof signature.
- Agent auth refresh is `POST /v1/agents/auth/refresh` with Claw proof.
- `registry-auth.json` shape is full auth bundle (`tokenType`, access/refresh tokens, expiries), not refresh-only.

3. Local persistence schema assumptions in Phase 3 were incomplete.
- TS pairing trust store is alias-based `peers.json` (`alias -> { did, proxyUrl, agentName?, humanName? }`), not DID-keyed trust-level rows.
- TS connector inbound inbox is a retry/dead-letter model with attempt metadata, not a simple `processed` boolean.
- TS connector has persistent outbound enqueue queue and dead-letter management endpoints.

4. Runtime transport model differs from the previous plan.
- TS connector uses WebSocket relay connect (`/v1/relay/connect`) + local HTTP runtime (`/v1/status`, `/v1/outbound`, dead-letter endpoints).
- TS behavior does not implement an SSE fallback path for connector runtime.

5. Command/module coverage in the previous plan missed major TS surfaces.
- Missing/under-modeled: `connector start`, `connector service install/uninstall`, connector runtime internals, openclaw doctor/relay diagnostics, and dead-letter operations.

## Phase 2 Remediation Gate (Before Phase 3)

These items must be completed before Phase 3 is treated as authoritative:
- Align config root/env precedence to TS (`.clawdentity`, router semantics including legacy migration flag behavior).
- Align DID parser/builder to `did:claw` grammar.
- Replace `/v1/register` assumption with TS agent registration challenge + registration flow.
- Align agent material schema on disk (`identity.json`, `ait.jwt`, `secret.key`, `public.key`, `registry-auth.json`).

---

## Phase 3: Persistence Model (SQLite) Aligned To TS Connector Semantics

### Files to Create
- `crates/clawdentity-core/src/db.rs`
- `crates/clawdentity-core/src/db_inbound.rs`
- `crates/clawdentity-core/src/db_outbound.rs`
- `crates/clawdentity-core/src/db_peers.rs`
- `crates/clawdentity-core/src/db_verify_cache.rs`

### Corrected Core Schema
```sql
CREATE TABLE IF NOT EXISTS peers (
    alias TEXT PRIMARY KEY,
    did TEXT NOT NULL,
    proxy_url TEXT NOT NULL,
    agent_name TEXT,
    human_name TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS outbound_queue (
    frame_id TEXT PRIMARY KEY,
    frame_version INTEGER NOT NULL,
    frame_type TEXT NOT NULL,
    to_agent_did TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    conversation_id TEXT,
    reply_to TEXT,
    created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS inbound_pending (
    request_id TEXT PRIMARY KEY,
    frame_id TEXT NOT NULL,
    from_agent_did TEXT NOT NULL,
    to_agent_did TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    payload_bytes INTEGER NOT NULL,
    received_at_ms INTEGER NOT NULL,
    next_attempt_at_ms INTEGER NOT NULL,
    attempt_count INTEGER NOT NULL,
    last_error TEXT,
    last_attempt_at_ms INTEGER,
    conversation_id TEXT,
    reply_to TEXT
);

CREATE TABLE IF NOT EXISTS inbound_dead_letter (
    request_id TEXT PRIMARY KEY,
    frame_id TEXT NOT NULL,
    from_agent_did TEXT NOT NULL,
    to_agent_did TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    payload_bytes INTEGER NOT NULL,
    received_at_ms INTEGER NOT NULL,
    attempt_count INTEGER NOT NULL,
    last_error TEXT,
    last_attempt_at_ms INTEGER,
    conversation_id TEXT,
    reply_to TEXT,
    dead_lettered_at_ms INTEGER NOT NULL,
    dead_letter_reason TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inbound_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at_ms INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    request_id TEXT,
    details_json TEXT
);

CREATE TABLE IF NOT EXISTS verify_cache (
    cache_key TEXT PRIMARY KEY,
    registry_url TEXT NOT NULL,
    fetched_at_ms INTEGER NOT NULL,
    payload_json TEXT NOT NULL
);
```

### Dependency Corrections
- Keep `rusqlite` (`bundled`) as primary storage dependency.
- Drop `refinery` as a required dependency; use explicit SQL migration files + migration table in-core unless a migration crate becomes necessary.

### Notes
- If a separate `messages` table is kept for product reasons, it must include at least `conversation_id`, `reply_to`, and frame/request correlation fields to avoid losing connector semantics.

---

## Phase 4: Connector Runtime (WebSocket + Local HTTP Runtime)

### Missing Modules To Add
- `crates/clawdentity-core/src/connector_frames.rs`
- `crates/clawdentity-core/src/connector_client.rs`
- `crates/clawdentity-core/src/runtime_server.rs`
- `crates/clawdentity-core/src/runtime_replay.rs`
- `crates/clawdentity-core/src/runtime_relay.rs`
- `crates/clawdentity-core/src/runtime_auth.rs`
- `crates/clawdentity-core/src/runtime_openclaw.rs`
- `crates/clawdentity-core/src/runtime_trusted_receipts.rs`

### Required Behavior
- WebSocket connect path parity (`/v1/relay/connect`) with signed upgrade headers.
- Heartbeat + ack timeout + reconnect backoff parity.
- Local HTTP runtime endpoints parity:
  - `GET /v1/status`
  - `POST /v1/outbound`
  - `GET /v1/inbound/dead-letter`
  - `POST /v1/inbound/dead-letter/replay`
  - `POST /v1/inbound/dead-letter/purge`

### Dependency Corrections
- Keep: `tokio`, `tokio-tungstenite`, `futures-util`.
- Add missing HTTP server stack (choose one and standardize): `axum` or `hyper`.
- Remove `eventsource-client` from required baseline for TS parity (SSE not part of current TS connector runtime behavior).

---

## Phase 5: Pairing + Trust Persistence

### Files to Create
- `crates/clawdentity-core/src/pairing.rs`
- `crates/clawdentity-core/src/peers.rs`
- `crates/clawdentity-core/src/qr.rs`

### Corrected Behavior
- `pair start`, `pair confirm`, `pair status` parity including:
  - ticket prefix `clwpair1_`
  - issuer-origin validation against configured proxy
  - optional `--wait`, `--wait-seconds`, `--poll-interval-seconds`
  - QR encode and QR decode path parity
- Persist peers by alias with `did/proxyUrl/agentName/humanName`.
- Sync OpenClaw relay peer snapshot when runtime config references a peer snapshot path.

### Dependency Corrections
- Keep `qrcode` + PNG/image generation.
- Add a QR decode crate (for parity with TS `jsqr` behavior), e.g. `quircs`/equivalent.

### Scope Correction
- `pair recover` remains deferred unless proxy API contract is finalized (still not present in TS CLI behavior).

---

## Phase 6: Verify + CRL

### Files to Create
- `crates/clawdentity-core/src/verify.rs`
- `crates/clawdentity-core/src/crl.rs`

### Corrected Behavior
- Match TS verify flow:
  - token-or-file input
  - registry key fetch from `/.well-known/claw-keys.json`
  - CRL fetch from `/v1/crl`
  - cache TTLs: keys (1 hour), CRL claims (15 minutes)
  - expected issuer enforcement for known prod/dev hosts
- Cache layout maps to `verify_cache` table.

### Dependency Corrections
- Do not require `jsonwebtoken` up front.
- Prefer strict Ed25519/JWT verification aligned with existing crypto stack (`ed25519-dalek`, base64url, serde) unless a tested JWT crate proves full TS-compatibility.

---

## Phase 7: Account Operations (API Keys, Invites, Admin)

### Files to Create
- `crates/clawdentity-core/src/api_key.rs`
- `crates/clawdentity-core/src/invite.rs`
- `crates/clawdentity-core/src/admin.rs`

### Endpoint/Schema Parity Targets
- `/v1/me/api-keys` create/list/revoke
- `/v1/invites` create
- `/v1/invites/redeem` redeem + local config persistence side effects
- `/v1/admin/bootstrap` bootstrap + local config persistence side effects

---

## Phase 8: Connector Service Management

### Files to Create
- `crates/clawdentity-core/src/service.rs`
- `crates/clawdentity-cli/src/commands/connector.rs`

### Corrected Scope
- TS parity baseline is:
  - `connector service install`
  - `connector service uninstall`
  - per-agent service naming + per-agent logs
- `service start/stop/status` can be added later, but they are not current TS parity requirements.

---

## Phase 9: OpenClaw Diagnostics + Relay Checks

### Missing Modules To Add
- `crates/clawdentity-core/src/openclaw_doctor.rs`
- `crates/clawdentity-core/src/openclaw_setup.rs`
- `crates/clawdentity-core/src/openclaw_relay_test.rs`

### Corrected Behavior
- Mirror TS doctor coverage categories (selected agent, credentials, peers, transform mapping, hook token, gateway pairing, connector runtime/inbound inbox health).
- Support relay functional check + websocket readiness check equivalent to TS openclaw command set.

---

## Phase 10: Hardening and Compatibility Closure

### Required Passes
1. Error code/message parity for all implemented command families.
2. Migration compatibility for existing local state layouts and legacy fields.
3. End-to-end parity tests for pairing, connector runtime, dead-letter replay, verify caches, and invite/admin onboarding flows.
4. Cross-platform service behavior verification (macOS launchd, Linux systemd).

---

## Updated Timeline

### Week 0 (Gate)
- Phase 2 remediation gate items (DID/config/registry contract alignment)

### Week 1
- Phase 3 persistence model + migration scaffolding
- Phase 4 connector runtime core (ws + outbound endpoint)

### Week 2
- Phase 4 completion (status + dead-letter endpoints)
- Phase 5 pairing/trust + QR

### Week 3
- Phase 6 verify/crl
- Phase 7 account operations
- Phase 8 connector service install/uninstall

### Week 4
- Phase 9 openclaw diagnostics/relay checks
- Phase 10 parity hardening + e2e matrix

---

## Updated Success Criteria
- [ ] Storage schema captures TS connector retry/dead-letter semantics (not reduced to `processed` flags)
- [ ] Agent registration/auth contracts match TS (`/v1/agents/challenge`, `/v1/agents`, `/v1/agents/auth/refresh`)
- [ ] Pairing trust persistence matches alias-based peer model
- [ ] Connector runtime endpoints and websocket behavior match TS contracts
- [ ] Verify key/CRL cache behavior matches TS TTL and issuer semantics
- [ ] Service commands match TS baseline (`connector service install/uninstall`)
- [ ] Doctor/relay diagnostics cover TS operational checks
- [ ] Cross-platform CI + integration tests green
