# Clawdentity Rust Architecture

This document describes the architecture implemented in `crates/clawdentity-core` and `crates/clawdentity-cli`.
It is based on current source code and structural tests in `clawdentity-core/tests/structural.rs`.

## 1) System Overview

Logical path for end-to-end relay and onboarding operations:

```text
+--------+      +-----------+      +----------+      +-------+      +----------+      +----------+
| Agent  | <--> | Connector | <--> | Registry | <--> | Relay | <--> | Provider | <--> | Platform |
+--------+      +-----------+      +----------+      +-------+      +----------+      +----------+
     ^                ^                 ^                ^                ^
     |                |                 |                |                |
     |                |                 |                |                +-- openclaw/picoclaw/nanobot/nanoclaw
     |                |                 |                +-- runtime HTTP + websocket queue flush
     |                |                 +-- metadata, agent auth, api keys, invites, CRL
     |                +-- websocket protocol, heartbeat, reconnect, service integration
     +-- DID identity + AIT auth
```

Implemented crates:

- `clawdentity-core`: core modules (`identity`, `registry`, `connector`, `runtime`, `providers`, `pairing`, `db`, `verify`).
- `clawdentity-cli`: user-facing command surface, including connector daemon start path.

## 2) Module Dependency Graph

### 2.1 High-level module map

```text
                  +-------------------+
                  |      error        |
                  +---------+---------+
                            |
+-----------+     +---------v---------+     +----------------+
| constants |---->|      identity     |<----|    registry    |
+-----------+     +----+---------+----+     +--------+-------+
                       |         |                   |
+-----------+          |         |                   |
|   http    |----------+         |                   |
+-----------+                    |                   |
                                 |                   v
                           +-----+------+      +-----+------+
                           |    verify   |<----|     db      |
                           +-----+------+      +-----+------+
                                 ^                   ^
                                 |                   |
                        +--------+--------+          |
                        |    pairing      |----------+
                        +--------+--------+
                                 |
                        +--------v--------+
                        |    providers    |
                        +--------+--------+
                                 ^
                                 |
                        +--------+--------+
                        |    connector    |
                        +--------+--------+
                                 |
                        +--------v--------+
                        |     runtime     |
                        +-----------------+
```

Notes:
- Diagram shows dependency direction used in source files, not runtime message flow.
- `runtime` depends on `connector` and `db`.
- `providers` depend on shared helpers and on `db`/`config` for state operations, but not on `runtime`.

### 2.2 Structural rules enforced by tests

Enforced in `clawdentity-core/tests/structural.rs`:

- `providers` may not import `runtime`.
- `connector` may not import `providers`.
- No `.unwrap()` is allowed outside test code.
- No Rust source file may exceed 800 lines.

### 2.3 Layer rules currently documented in plan

`docs/HARNESS_ACTION_PLAN.md` documents the intended layer shape:

```text
identity -> (nothing)
registry -> identity
db -> (nothing)
connector -> db, identity
runtime -> connector, db
providers -> identity, db, connector (NOT runtime)
pairing -> identity, db
```

The hard-enforced subset today is the `providers -> runtime` and `connector -> providers` constraints.

## 3) Data Flow

### 3.1 Registration flow (agent registration)

```text
CLI: agent create
  -> registry/agent.rs:create_agent
  -> generate Ed25519 keypair for agent
  -> POST /v1/agents/challenge (Bearer API key)
  -> sign canonical challenge proof
  -> POST /v1/agents (Bearer API key)
  -> receive {agent, ait, agentAuth}
  -> persist to ~/.clawdentity/states/<state>/agents/<name>/
       - identity.json
       - ait.jwt
       - secret.key
       - public.key
       - registry-auth.json
```

Supporting setup flows:
- Human identity init: `identity/init_identity` creates local DID and secret material.
- Admin bootstrap and invite redeem persist API key + human/proxy config into routed state config.

### 3.2 Pairing flow

```text
Initiator: pair/start
  -> reads local agent AIT + secret key
  -> signs POST /pair/start request
  -> receives ticket + expiry
  -> optional QR persist under state pairing directory

Responder: pair/confirm
  -> parses ticket or QR
  -> signs POST /pair/confirm
  -> on success persists peer alias + proxy URL in SQLite peers table
  -> syncs OpenClaw relay peer snapshot if configured

Status polling:
  -> POST /pair/status (or GET /pair/status/<ticket> in mocks)
  -> if confirmed, persists peer data for local responder/initiator counterpart
```

Key files:
- `clawdentity-core/src/pairing/pairing.rs`
- `clawdentity-core/src/pairing/qr.rs`
- `clawdentity-core/src/pairing/peers.rs`

### 3.3 Message relay flow

Outbound (local -> proxy websocket):

```text
client POST /v1/outbound (runtime server)
  -> runtime/server.rs enqueues row in outbound_queue
  -> runtime/relay.rs flush_outbound_queue_to_relay
  -> converts row to ConnectorFrame::Enqueue
  -> connector client sends via websocket
  -> proxy routes to destination agent
```

Inbound (proxy websocket -> provider webhook):

```text
connector client receives ConnectorFrame::Deliver
  -> CLI connector loop forwards to provider hook (OpenClaw hook URL)
  -> on success: append inbound event = delivered
  -> on failure: upsert inbound_pending + event = pending
  -> always attempt DeliverAck, accepted=false when delivery/persistence failed
```

Replay/dead-letter:
- `inbound_pending` entries are retried with backoff metadata.
- Failed retries can be moved to `inbound_dead_letter`.
- Runtime endpoints support list/replay/purge of dead-letter entries.

### 3.4 Connector lifecycle

```text
connector start
  -> resolve agent material + proxy ws URL + signed relay headers
  -> spawn websocket ConnectorClient (heartbeat, reconnect, metrics)
  -> start runtime HTTP server (/v1/status, /v1/outbound, dead-letter routes)
  -> start inbound loop (deliver -> provider hook)
  -> start periodic outbound flush loop
  -> on signal: graceful shutdown + stop websocket
```

Connector service management:
- `connector/service.rs` renders and installs launchd/systemd service files.

## 4) Key Types and Relationships

### 4.1 Identity and signing

- DID: generated and parsed in `identity/did.rs` (`did:claw:{human|agent}:<ULID>`).
- Human identity: `LocalIdentity` in `identity/identity.rs`.
- Agent identity record: `AgentIdentityRecord` in `registry/agent.rs`.
- Signing keys: `ed25519_dalek::SigningKey` used for:
  - HTTP canonical proof headers (`identity/signing.rs`)
  - Agent registration challenge signatures
  - Pairing request signatures
  - Relay connect signed headers

### 4.2 Connector types

- `ConnectorClient` and `ConnectorClientSender` (`connector/client.rs`): websocket lifecycle, frame send/recv, health metrics.
- `ConnectorFrame` variants (`connector/frames.rs`): heartbeat, deliver, enqueue, ack frames.
- Connector service types (`connector/service.rs`): install/uninstall payloads and result records.

### 4.3 Provider abstraction

- `PlatformProvider` trait (`providers/mod.rs`):
  - `detect`, `install`, `verify`, `doctor`, `setup`, `relay_test`, plus inbound formatting methods.
- Implementations:
  - `OpenclawProvider`
  - `PicoclawProvider`
  - `NanobotProvider`
  - `NanoclawProvider`

### 4.4 Runtime server and relay handlers

- Runtime state/router types:
  - `RuntimeServerState`
  - `create_runtime_router`
  - `run_runtime_server`
- Relay handling logic:
  - `flush_outbound_queue_to_relay` in `runtime/relay.rs`
  - connector inbound handler path in CLI `commands/connector.rs` (deliver forwarding + ack + persistence)

There is no single `RelayHandler` struct currently; relay behavior is split across runtime and connector command module.

## 5) Database Schema and Migration Strategy

SQLite is managed by `db/mod.rs` (`rusqlite`, WAL mode, foreign keys on).

### 5.1 Tables

- `schema_migrations`: applied migration names + timestamp.
- `peers`: peer alias, DID, proxy URL, optional names, timestamps.
- `outbound_queue`: queued outbound frames.
- `outbound_dead_letter`: malformed/failed outbound payloads.
- `inbound_pending`: inbound deliveries pending retry.
- `inbound_dead_letter`: exhausted/failed inbound deliveries.
- `inbound_events`: event timeline for inbound processing.
- `verify_cache`: cached registry keys / CRL payloads.

### 5.2 Migration strategy

- Migrations are embedded SQL constants applied at startup.
- Current migrations:
  - `0001_phase3_persistence_model`
  - `0002_outbound_dead_letter`
- `SqliteStore::open*` calls `apply_migrations` before use.
- Migrations are idempotent via `schema_migrations` checks.

## 6) Security Model

### 6.1 DID-based identity

- Identity primitives are DID strings with strict parser validation.
- DID kind enforcement is used throughout (agent vs human checks).

### 6.2 Ed25519 signing

- All keypairs are Ed25519 (`ed25519_dalek`).
- HTTP requests requiring proof use canonical request signatures and deterministic header set:
  - `X-Claw-Timestamp`
  - `X-Claw-Nonce`
  - `X-Claw-Body-SHA256`
  - `X-Claw-Proof`

### 6.3 Relay authentication

- Relay websocket connect uses `Authorization: Claw <AIT>` plus signed proof headers.
- Pairing and auth refresh endpoints are called with signed canonical proofs.
- Connector deliver path emits explicit negative ACK when delivery or persistence fails.

### 6.4 CRL and key verification

- AIT verification (`verify.rs`) fetches registry keys from `/.well-known/claw-keys.json`.
- CRL fetch/verify (`registry/crl.rs`) validates signed CRL JWT and checks revocation JTI.
- Both keys and CRL payloads are cached in `verify_cache` with TTL.

## 7) Provider Architecture

### 7.1 `PlatformProvider` trait contract

Each provider must implement:

- identity methods: `name`, `display_name`
- detection: `detect`
- webhook shape: `format_inbound`, `default_webhook_host`, `default_webhook_port`, `config_path`
- lifecycle operations: `install`, `verify`, `doctor`, `setup`, `relay_test`

### 7.2 Doctor / setup / relay-test behavior

- `doctor`: emits structured checks with pass/fail, message, remediation hint, optional details.
- `setup`: persists provider runtime metadata and selected agent marker in Clawdentity state.
- `relay_test`: sends synthetic probe payload to provider endpoint, optional preflight via doctor.

OpenClaw has additional specialized behavior:
- selected-agent marker + connector assignment files
- runtime hook token/base URL management
- websocket status checks and peer-specific send-to-peer probes

### 7.3 Adding a new provider

Minimal steps:

1. Add `src/providers/<name>.rs` implementing `PlatformProvider`.
2. Register module and export in `providers/mod.rs`.
3. Implement install/verify/doctor/setup/relay_test with actionable failure messages.
4. Add detection evidence and config path strategy.
5. Reuse shared provider helpers for runtime config and connector checks.
6. Add tests for detect + inbound format + setup/relay behavior.
7. Ensure no forbidden dependency inversion (especially `providers -> runtime`).

## 8) CLI and Mock Services in Architecture

- `clawdentity-cli` is the control plane for identity, registry operations, provider workflows, and connector daemon execution.
- `tests/local/mock-registry` simulates registry metadata/auth/api-key/invite/pairing/CRL endpoints.
- `tests/local/mock-proxy` simulates websocket relay routing and pairing endpoints for local integration scenarios.

## 9) Operational Invariants

- Structural test gate (`clawdentity-core/tests/structural.rs`) is the hard safety net for:
  - file size limit
  - `.unwrap()` usage outside tests
  - key dependency inversion checks
- Runtime status endpoint (`/v1/status`) is the primary local health signal for connector runtime and queue state.

