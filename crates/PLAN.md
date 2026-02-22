# Clawdentity Rust CLI Plan

Inputs reviewed for this plan:
- GitHub issue `#179`: `https://github.com/vrknetha/clawdentity/issues/179`
- Current TypeScript CLI and connector runtime under `apps/cli/src/` and `packages/connector/src/`

This document is planning only. No Rust implementation is included.

## 1. Crate Structure And File Layout

```text
crates/
├── Cargo.toml                            # Workspace manifest (members + shared deps/lints)
├── clawdentity-core/
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs
│       ├── error.rs                      # Shared error enums + mappers
│       ├── identity.rs                   # Ed25519 keypair load/generate/encode
│       ├── did.rs                        # did:cdi parse/build/validate
│       ├── ait.rs                        # AIT parse/inspect/verify helpers
│       ├── signing.rs                    # Canonical request signing + X-Claw headers
│       ├── config.rs                     # ~/.clawdentity paths, state router, env overrides
│       ├── db.rs                         # SQLite connection, migrations bootstrap
│       ├── db_messages.rs                # messages + inbox read/write/query
│       ├── db_outbox.rs                  # outbox queue + retry scheduling
│       ├── db_peers.rs                   # peers trust store CRUD
│       ├── db_inbound_inbox.rs           # inbound_inbox persistence (TS parity)
│       ├── registry.rs                   # metadata, agent, api-key, invite, admin clients
│       ├── proxy.rs                      # send/poll + WS/SSE listen client
│       ├── messaging.rs                  # send/inbox/listen orchestration
│       ├── agent.rs                      # create/inspect/auth refresh/revoke
│       ├── pairing.rs                    # pair start/confirm/status/recover + ticket parsing
│       ├── trust.rs                      # lookup/revoke/peer trust operations
│       ├── invite.rs                     # invite create/redeem flow
│       ├── api_key.rs                    # api-key create/list/revoke
│       ├── admin.rs                      # admin bootstrap
│       ├── crl.rs                        # CRL cache/fetch/refresh policy
│       ├── verify.rs                     # AIT verification via keys + CRL
│       ├── qr.rs                         # pairing QR encode/decode
│       ├── service.rs                    # launchd/systemd install/uninstall/status
│       ├── doctor.rs                     # full diagnostics + remediation model
│       └── status.rs                     # quick health summary
├── clawdentity-cli/
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs
│       ├── output.rs                     # human + json formatters
│       ├── exit_codes.rs
│       └── commands/
│           ├── mod.rs
│           ├── init.rs
│           ├── whoami.rs
│           ├── register.rs
│           ├── agent.rs
│           ├── send.rs
│           ├── inbox.rs
│           ├── listen.rs
│           ├── pair.rs
│           ├── revoke.rs
│           ├── lookup.rs
│           ├── verify.rs
│           ├── api_key.rs
│           ├── invite.rs
│           ├── admin.rs
│           ├── config.rs
│           ├── service.rs
│           ├── doctor.rs
│           └── status.rs
└── tests/
    ├── fixtures/                         # protocol + JSON fixtures reused across crates
    ├── integration-registry/
    ├── integration-proxy/
    └── e2e-cli/
```

Layout principles:
- `clawdentity-core` owns all business logic and protocol IO.
- `clawdentity-cli` is a thin clap-based command surface and formatter only.
- Keep command names and flags mapped 1:1 with issue `#179`.
- Keep all local state under `~/.clawdentity` and preserve prod/dev/local routing semantics.

## 2. Dependency List With Versions

Versions below are taken from crates.io current stable releases and should be pinned in `Cargo.lock` at scaffold time.

| Crate | Version | Planned Use |
|---|---:|---|
| `clap` | `4.5.60` | CLI parsing and subcommand tree |
| `tokio` | `1.49.0` | async runtime (ws/sse/poll/background retry) |
| `reqwest` | `0.13.2` | HTTP client for registry/proxy APIs |
| `tokio-tungstenite` | `0.28.0` | WebSocket listen mode |
| `eventsource-client` | `0.16.2` | SSE listen fallback |
| `rusqlite` | `0.38.0` | embedded SQLite (`bundled`) |
| `ed25519-dalek` | `2.2.0` | signing + signature verification |
| `sha2` | `0.10.9` | request body SHA-256 for Claw proof headers |
| `base64` | `0.22.1` | base64url encode/decode helpers |
| `serde` | `1.0.228` | serialization |
| `serde_json` | `1.0.149` | JSON payloads/config/cache |
| `toml` | `1.0.3` | `config.toml` parsing/writing |
| `url` | `2.5.8` | URL normalization and validation |
| `ulid` | `1.2.1` | ULID parsing/creation parity with TS |
| `qrcode` | `0.14.1` | pairing ticket QR generation |
| `image` | `0.25.9` | image buffer encoding for QR output |
| `png` | `0.18.1` | direct PNG writing/validation |
| `directories` | `6.0.0` | home/config path resolution |
| `time` | `0.3.47` | timestamp handling and formatting |
| `rand` | `0.10.0` | nonce generation |
| `futures-util` | `0.3.32` | stream combinators for ws/sse |
| `tokio-stream` | `0.1.18` | async stream adapters |
| `thiserror` | `2.0.18` | typed error enums |
| `anyhow` | `1.0.102` | CLI command error propagation |
| `tracing` | `0.1.44` | structured logs |
| `tracing-subscriber` | `0.3.22` | log formatting/filtering |

Test/dev dependencies:

| Crate | Version | Planned Use |
|---|---:|---|
| `assert_cmd` | `2.1.2` | black-box CLI tests |
| `predicates` | `3.1.4` | CLI output assertions |
| `tempfile` | `3.25.0` | isolated filesystem/db test state |
| `wiremock` | `0.6.5` | registry/proxy HTTP contract tests |
| `insta` | `1.46.3` | snapshot tests for formatted output |
| `serial_test` | `3.4.0` | serialize tests that mutate global env |

## 3. Implementation Order (Module-First)

1. Foundation scaffolding:
- Workspace + crate manifests
- Core error types, logging bootstrap, shared models
- `config.rs` with state router (`prod/dev/local`) and path policy

2. Identity + registration baseline:
- `identity.rs`, `did.rs`, `ait.rs`, `signing.rs`
- `registry.rs` minimal endpoints for metadata + registration
- CLI commands: `init`, `whoami`, `register`, `config init/set/get/show`

3. Agent lifecycle parity:
- `agent.rs` with create/inspect/auth refresh/revoke
- Filesystem parity for agent material (`identity.json`, `ait.jwt`, `secret.key`, `registry-auth.json`)
- CLI command: `agent ...`

4. SQLite core and messaging:
- `db.rs` migrations + tables: `messages`, `outbox`, `peers`, `inbound_inbox`
- `messaging.rs` send/inbox/poll + outbox retry worker
- CLI commands: `send`, `inbox`

5. Real-time relay client:
- `proxy.rs` websocket listen and SSE listen, reconnect/backoff
- Webhook forward path in `listen --webhook`
- CLI command: `listen`, `listen --sse`, `listen --webhook`

6. Trust and pairing:
- `pairing.rs`, `trust.rs`, `qr.rs`
- Pair start/confirm/status/recover, peer persistence, revoke/lookup
- CLI commands: `pair ...`, `revoke`, `lookup`

7. Account/admin operations:
- `api_key.rs`, `invite.rs`, `admin.rs`
- CLI commands: `api-key ...`, `invite ...`, `admin bootstrap`

8. Verification + CRL:
- `crl.rs`, `verify.rs`
- Registry signing key cache + CRL cache + AIT verification pipeline
- CLI command: `verify`

9. Service and diagnostics:
- `service.rs` for launchd/systemd install/uninstall/status
- `doctor.rs`, `status.rs` checks and remediation messages
- CLI commands: `service ...`, `doctor`, `status`

10. Hardening and parity closure:
- Error-message parity pass against TS behavior
- Output format stabilization (human + json)
- End-to-end matrix against proxy/registry dev/local/prod environments

## 4. Portability: TS Direct Port vs Rewrite

| Area | Source In TS | Port Strategy |
|---|---|---|
| Config router and env precedence | `apps/cli/src/config/manager.ts` | Direct behavior port (same precedence, new Rust implementation) |
| Agent create/inspect/auth/revoke flows | `apps/cli/src/commands/agent/*` | Direct logic port, filesystem + HTTP layers rewritten in Rust |
| API key commands | `apps/cli/src/commands/api-key.ts` | Direct contract/error mapping port |
| Invite create/redeem | `apps/cli/src/commands/invite.ts` | Direct contract port with same config persistence behavior |
| Admin bootstrap | `apps/cli/src/commands/admin.ts` | Direct contract port |
| Pair start/confirm/status and ticket parsing | `apps/cli/src/commands/pair/*` | Direct protocol behavior port, storage target changes to SQLite |
| Verify with registry keys + CRL cache | `apps/cli/src/commands/verify.ts` | Direct verification flow port with Rust crypto libs |
| Connector websocket/session/retry semantics | `packages/connector/src/client/*` | Partial logic port, but reorganized into `listen` architecture |
| Inbound inbox handling | `packages/connector/src/inbound-inbox.ts` | Rewrite persistence from JSON index/events to SQLite `inbound_inbox` |
| Connector runtime local HTTP server | `packages/connector/src/runtime/server.ts` | Rewrite: Clawdentity CLI becomes direct sender/listener, no local connector endpoint dependency |
| OpenClaw-specific commands | `apps/cli/src/commands/openclaw/*` | Replace with platform-agnostic `doctor` + `status` checks |
| Service install/uninstall | `apps/cli/src/commands/connector/service.ts` | Port launchd/systemd behavior, add explicit `service status` |

## 5. API/Protocol Compatibility Notes

Registry compatibility:
- Preserve endpoint contracts used today: `/v1/metadata`, `/v1/agents`, `/v1/agents/challenge`, `/v1/agents/auth/refresh`, `/v1/me/api-keys`, `/v1/invites`, `/v1/invites/redeem`, `/v1/admin/bootstrap`.
- Keep current auth model: PAT (`Bearer`) for user/admin operations, `Claw <AIT>` + signed headers for agent/proxy paths.

Proxy compatibility:
- Keep pairing endpoints and ticket semantics from TS: `/pair/start`, `/pair/confirm`, `/pair/status`, ticket prefix `clwpair1_`.
- Keep websocket handshake signing model currently used by connector runtime.
- Delivery modes must remain equivalent: WebSocket default, SSE fallback, polling fallback.

Signing/canonicalization compatibility:
- Preserve canonical request algorithm from `@clawdentity/protocol` (`CLAW-PROOF-V1`).
- Preserve header names: `X-Claw-Timestamp`, `X-Claw-Nonce`, `X-Claw-Body-SHA256`, `X-Claw-Proof`.
- Preserve DID/ULID validation semantics to avoid cross-language signature mismatches.

Storage compatibility:
- Implement required SQL schema tables: `messages`, `outbox`, `peers`, `inbound_inbox`.
- Keep message status/domain semantics aligned with issue `#179` (`received/read/delivered/failed`, inbound/outbound).
- Keep multi-env state routing under `~/.clawdentity/states/{prod,dev,local}`.

Parity caveats to lock before coding:
- `pair recover` is specified in issue `#179` but not implemented in current TS CLI; endpoint/behavior must be finalized with proxy contract.
- `service status` is specified for Rust CLI but not present in current TS connector service command; define status contract per OS.
- Issue text shows both `messages.db` and `trust.db` while SQL snippet includes `peers`; decide final table-to-file split at scaffold time and keep a migration path.

## 6. Testing Strategy

Test pyramid:
- Unit tests in `clawdentity-core` for parsing, signing, canonicalization, config routing, DB repositories, retry scheduling.
- Contract tests using `wiremock` for registry and proxy HTTP semantics, including error-code mapping.
- WebSocket/SSE integration tests with local test servers for reconnect, heartbeat, and backoff behavior.
- CLI integration tests with `assert_cmd` validating command UX, exit codes, and JSON/human output.

Parity-driven test targets:
- Reuse behavior from TS tests where possible: agent/auth, invite, api-key, pair, config, verify.
- Build fixture-based tests for AIT decode/verify and pairing ticket parse edge cases.
- Add offline-first tests: no network, outbox enqueue, later replay on connectivity restore.

Database tests:
- Migration tests that validate schema creation and index presence.
- Repository tests for `messages`, `outbox`, `peers`, `inbound_inbox`.
- Crash-safety tests for outbox retry state and idempotent message processing.

Diagnostics and service tests:
- `doctor` check matrix with deterministic mocked failures and remediation text assertions.
- OS-gated tests for service install/uninstall/status (launchd/systemd), including idempotency.

Acceptance/e2e:
- End-to-end against local dev registry/proxy (same environment model as current repo).
- Command parity checklist derived from issue `#179` feature matrix.

## 7. Estimated Complexity Per Module

Scale: `S` (small), `M` (medium), `L` (large), `XL` (very large).

| Module | Complexity | Why |
|---|---|---|
| `config` | `M` | Multi-env routing, env precedence, secure file writes |
| `identity` + `did` + `ait` + `signing` | `M` | Deterministic crypto/parsing parity required |
| `registry` | `M` | Many endpoints but straightforward HTTP client logic |
| `agent` | `M` | Combines FS material management with registry flows |
| `db` + repositories | `L` | Schema lifecycle + query correctness + offline semantics |
| `messaging` (`send`, `inbox`, polling, outbox retry) | `L` | Queue state machine and failure handling |
| `proxy` listen (WS + SSE + webhook) | `XL` | Stateful streaming, reconnect, backpressure, graceful shutdown |
| `pairing` + `qr` + `trust` | `L` | Ticket validation, signature headers, peer persistence |
| `api_key` + `invite` + `admin` | `M` | Contract-rich but mostly request/response operations |
| `crl` + `verify` | `L` | Key cache policy + cryptographic verification correctness |
| `service` | `M` | OS-specific launchd/systemd behavior and status probing |
| `doctor` + `status` | `L` | Broad check surface and actionable remediation output |
| `clawdentity-cli` command layer | `M` | Many commands, mostly thin wrappers if core stays clean |

Suggested execution sequence by risk:
1. `config`, `identity`, `signing`, `registry`, `agent`
2. `db`, `messaging`, `proxy listen`
3. `pairing/trust`, `verify/crl`
4. `api_key/invite/admin`, `service`, `doctor/status`
