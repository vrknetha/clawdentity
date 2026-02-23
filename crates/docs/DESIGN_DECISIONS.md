# Design Decisions

This document records core design choices in the Rust workspace and why they were made.
All points are based on current implementation in `clawdentity-core` and `clawdentity-cli`.

## 1) Single binary for CLI and daemon

Decision:
- Keep CLI workflows and connector daemon runtime in one executable (`clawdentity-cli`).

Why:
- Identity/config/state handling is shared across interactive commands and long-running connector mode.
- Users can bootstrap, configure, inspect, and run relay on machines that may be offline or minimally provisioned.
- Operationally simpler distribution: one binary, one version, one upgrade surface.

Evidence in code:
- `clawdentity-cli/src/main.rs` dispatches both command-style operations and `connector start` daemon path.
- `clawdentity-cli/src/commands/connector.rs` hosts runtime loops (websocket, outbound server, inbound handling).

Tradeoff:
- Larger command binary and tighter coupling between control-plane and runtime concerns.

## 2) SQLite for local persistence (not Postgres/Redis)

Decision:
- Use local SQLite (`rusqlite` bundled) as primary persistence engine.

Why:
- Zero external service dependency fits local/offline execution model.
- Required durability scope is local state: queues, peers, verification cache, dead-letter bookkeeping.
- Migration and bootstrap are deterministic at process startup.

Evidence in code:
- `clawdentity-core/src/db/mod.rs`: `SqliteStore`, WAL mode, migration application.
- Schema supports relay and verification workflows (`outbound_queue`, `inbound_pending`, `verify_cache`, etc.).

Tradeoff:
- Single-node local storage; horizontal concurrency/distributed coordination is intentionally out of scope.

## 3) Ed25519 for request and token signatures

Decision:
- Standardize on Ed25519 for signing/verification.

Why:
- Fast key generation and signature checks for local runtime.
- Compact key representation works well with base64url transport and JWT/JWK style payloads.
- Same crypto primitive is used across agent auth, relay proof headers, pairing requests, and CRL verification.

Evidence in code:
- `identity/signing.rs`, `registry/agent.rs`, `pairing/pairing.rs`, `runtime/auth.rs`, `verify.rs`, `registry/crl.rs`.

Tradeoff:
- Reduced algorithm flexibility; interoperability is centered on EdDSA/Ed25519 only.

## 4) DID format for identities

Decision:
- Represent identities as custom DID strings (`did:claw:<kind>:<ulid>`).

Why:
- Clear type separation between human and agent identities.
- Stable parse/validate path with strict format checks.
- Consistent subject fields across local identity files, AIT payloads, and pairing/peer records.

Evidence in code:
- `identity/did.rs` (`ClawDidKind`, `make_*_did`, `parse_did`).
- DID kind checks appear in connector frames, CRL claims, AIT verification.

Tradeoff:
- Custom method namespace requires strict parser ownership and migration discipline if format evolves.

## 5) WebSocket connector instead of polling HTTP

Decision:
- Use websocket connector protocol for relay (`/v1/relay/connect`) with typed frames and heartbeats.

Why:
- Full-duplex message delivery and acknowledgements without polling latency.
- Connection health is explicit via heartbeat/ack timeout and reconnect policy.
- Natural fit for queued outbound flush + inbound push delivery semantics.

Evidence in code:
- `connector/client.rs` and `connector/frames.rs`.
- `runtime/relay.rs` flushes outbound queue into websocket enqueue frames.

Tradeoff:
- Connection lifecycle complexity (reconnect timing, session transitions, heartbeat handling).

## 6) Provider trait abstraction for platform integrations

Decision:
- Integrate platforms through a common `PlatformProvider` trait.

Why:
- One contract for detect/install/verify/doctor/setup/relay-test across providers.
- Keeps provider-specific config formats isolated (`openclaw`, `picoclaw`, `nanobot`, `nanoclaw`).
- Allows CLI to dispatch provider operations consistently while preserving per-platform behavior.

Evidence in code:
- Trait in `providers/mod.rs`.
- Implementations in `providers/openclaw/*`, `providers/picoclaw.rs`, `providers/nanobot.rs`, `providers/nanoclaw.rs`.

Tradeoff:
- Shared trait can become broad; each new method raises implementation burden across providers.

## 7) Structural tests over lint-only enforcement

Decision:
- Enforce architecture/quality invariants using Rust tests (`tests/structural.rs`) instead of only lint config.

Why:
- Constraints are repository-specific (line limits, dependency inversion, unwrap policy).
- Test failures can include remediation-focused messages for developer and agent workflows.
- Policy enforcement stays inside the normal `cargo test` lifecycle.

Evidence in code:
- `clawdentity-core/tests/structural.rs` validates:
  - max 800 lines per Rust file
  - no `.unwrap()` outside tests
  - no `providers -> runtime` imports
  - no `connector -> providers` imports

Tradeoff:
- Rule set is custom and must be maintained as architecture evolves.

