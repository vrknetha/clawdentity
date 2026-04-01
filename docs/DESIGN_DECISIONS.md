# Design Decisions

This document records architecture decisions for the entire Clawdentity monorepo.
It includes monorepo-wide decisions first, then Rust-specific decisions that originated in `crates/docs/`.

## Monorepo-Wide Decisions

## 1) Single monorepo for TypeScript + Rust

Decision:
- Keep apps, shared TypeScript packages, Rust core, Rust CLI, and local mock services in one repository.

Why:
- Protocol and security changes must stay synchronized across registry, proxy, SDK, connector, and the Rust CLI/runtime.
- Release coordination is simpler when cross-language validation runs in one place.
- Operator workflows (invite, identity, pairing, OpenClaw asset install, connector runtime) depend on tight compatibility.

Tradeoff:
- Higher CI complexity and stricter dependency discipline are required.

## 2) Hosted control plane on Cloudflare Workers

Decision:
- Keep registry and proxy as Cloudflare Worker apps (`apps/registry`, `apps/proxy`).

Why:
- Fast deployment and consistent edge/runtime model.
- Registry + proxy are naturally HTTP/worker-style services.
- D1 + Wrangler provide operationally simple deploy/migrate workflows.

Tradeoff:
- Worker runtime constraints must be considered for package/runtime design.

## 3) OpenClaw integration via proxy + skill (no OpenClaw fork)

Decision:
- Integrate by placing Clawdentity verification at proxy boundary and installing OpenClaw skill artifacts locally.

Why:
- Avoid maintaining an OpenClaw fork.
- Keep OpenClaw hook token private while exposing only signed Clawdentity request surface.
- Keep OpenClaw as the owner of OpenClaw config and gateway auth semantics.
- Preserve local/offline-friendly operator behavior with minimal platform intrusion.

Tradeoff:
- Adds an extra integration layer (skill + proxy + connector) that must remain version-compatible.

## 4) Single Rust CLI surface

Decision:
- Keep `crates/clawdentity-cli` as the only supported operator surface and release path.

Why:
- OpenClaw provider setup, pairing, verification, connector runtime, and release assets now ship from one executable.
- One CLI avoids drift in command semantics, config paths, and release automation.
- The Rust binary owns the embedded OpenClaw skill artifacts needed for offline and containerized installs.

Tradeoff:
- Rust release automation must stay strict because there is no secondary CLI fallback.

## 5) Shared protocol package as canonical contract

Decision:
- Keep protocol/wire definitions centralized (`packages/protocol`) and align Rust semantics to the same model.

Why:
- Identity and auth contracts are the highest-risk compatibility surface.
- Registry, proxy, SDK, connector, skill, and Rust runtime must verify the same claims and signatures.

Tradeoff:
- Protocol changes require broader rollout planning and compatibility validation.

## 6) Explicit group routing and canonical inbound metadata

Decision:
- Treat direct delivery and group delivery as different trust paths, and keep inbound sender/group metadata on the canonical no-legacy field names.

Why:
- Group routing is not just "pairing plus more recipients"; it depends on registry-backed membership and group-specific authorization.
- Canonical field names (`displayName`, `groupId`, `groupName`, `senderDisplayName`) keep registry responses, connector payloads, and OpenClaw-facing metadata aligned.
- Hard-cut metadata avoids long-lived fallback code paths that make auth and debugging harder.

Tradeoff:
- Contract cutovers are stricter, so docs and release assets must be updated at the same time as runtime changes.

## Rust-Specific Decisions

The sections below are preserved and maintained from the original Rust-focused design decisions document.

## R1) Single binary for Rust CLI and daemon

Decision:
- Keep CLI workflows and connector daemon runtime in one executable (`clawdentity-cli`).

Why:
- Identity/config/state handling is shared across interactive commands and long-running connector mode.
- Users can bootstrap, configure, inspect, and run relay on machines that may be offline or minimally provisioned.
- Operationally simpler distribution: one binary, one version, one upgrade surface.
- OpenClaw setup still stays first-party: operators repair OpenClaw with `openclaw onboard` or `openclaw doctor --fix` before layering Clawdentity relay setup.

Evidence in code:
- `crates/clawdentity-cli/src/main.rs` dispatches both command-style operations and `connector start` daemon path.
- `crates/clawdentity-cli/src/commands/connector.rs` hosts runtime loops (websocket, outbound server, inbound handling).

Tradeoff:
- Larger command binary and tighter coupling between control-plane and runtime concerns.

## R2) SQLite for local persistence

Decision:
- Use local SQLite (`rusqlite` bundled) as primary persistence engine.

Why:
- Zero external service dependency fits local/offline execution model.
- Required durability scope is local state: queues, peers, verification cache, dead-letter bookkeeping.
- Migration and bootstrap are deterministic at process startup.

Evidence in code:
- `crates/clawdentity-core/src/db/mod.rs`: `SqliteStore`, WAL mode, migration application.
- Schema supports relay and verification workflows (`outbound_queue`, `inbound_pending`, `verify_cache`, etc.).

Tradeoff:
- Single-node local storage; distributed coordination is intentionally out of scope.

## R3) Ed25519 for request and token signatures

Decision:
- Standardize on Ed25519 for signing and verification.

Why:
- Fast key generation and signature checks for local runtime.
- Compact key representation works well with base64url transport and JWT/JWK payloads.
- Same primitive is used across agent auth, relay proof headers, pairing requests, and CRL verification.

Evidence in code:
- `crates/clawdentity-core/src/identity/signing.rs`
- `crates/clawdentity-core/src/registry/agent.rs`
- `crates/clawdentity-core/src/pairing/pairing.rs`
- `crates/clawdentity-core/src/runtime/auth.rs`
- `crates/clawdentity-core/src/verify.rs`
- `crates/clawdentity-core/src/registry/crl.rs`

Tradeoff:
- Algorithm flexibility is intentionally narrow.

## R4) DID format for identities

Decision:
- Represent identities as `did:cdi:<authority>:<entity>:<ulid>`.

Why:
- Clear type separation between human and agent identities.
- Stable parse/validate path with strict format checks.
- Consistent subject fields across local identity files, AIT payloads, and pairing/peer records.

Evidence in code:
- `crates/clawdentity-core/src/identity/did.rs`

Tradeoff:
- DID format evolution requires careful migration discipline.

## R5) WebSocket connector instead of polling HTTP

Decision:
- Use websocket connector protocol (`/v1/relay/connect`) with typed frames and heartbeats.

Why:
- Full-duplex delivery and acknowledgements without polling latency.
- Explicit connection-health semantics (heartbeat/ack/reconnect policy).
- Natural fit for queued outbound flush + inbound push semantics.

Evidence in code:
- `crates/clawdentity-core/src/connector/client.rs`
- `crates/clawdentity-core/src/connector/frames.rs`
- `crates/clawdentity-core/src/runtime/relay.rs`

Tradeoff:
- Connection lifecycle complexity (reconnect timing, session transitions, heartbeat handling).

## R6) Provider trait abstraction for platform integrations

Decision:
- Integrate platforms through a common `PlatformProvider` trait.

Why:
- One contract for detect/install/verify/doctor/setup/relay-test across providers.
- Isolates provider-specific config/runtime details (`openclaw`, `picoclaw`, `nanobot`, `nanoclaw`, `hermes`).
- Allows CLI to dispatch provider operations consistently.

Evidence in code:
- Trait: `crates/clawdentity-core/src/providers/mod.rs`
- Implementations: provider modules under `crates/clawdentity-core/src/providers/`

Tradeoff:
- Shared trait growth increases maintenance cost across providers.

## R7) Structural tests for architecture enforcement

Decision:
- Enforce key architecture/quality invariants with Rust structural tests instead of lint-only policy.

Why:
- Constraints are repository-specific (line limits, dependency inversion, unwrap policy).
- Failure messages can include remediation guidance.
- Policy enforcement stays in normal `cargo test` workflow.

Evidence in code:
- `crates/clawdentity-core/tests/structural.rs` validates:
  - max 800 lines per Rust file
  - no `.unwrap()` outside tests
  - no `providers -> runtime` imports
  - no `connector -> providers` imports

Tradeoff:
- Rule set is custom and must evolve with architecture changes.
