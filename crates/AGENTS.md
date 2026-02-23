# AGENTS.md

## Project Overview
Clawdentity is a decentralized identity and encrypted relay system for AI agents.
This `crates/` workspace contains the Rust core library, CLI, and local mock services used for integration flows.

## Build Commands
Run from `crates/`:
- `cargo check`
- `cargo clippy --all-targets`
- `cargo test`
- `cargo build --release`

## Module Map (`clawdentity-core/src`)
- `db/` - SQLite persistence layer (queues, peers, verification cache, migrations)
- `identity/` - DID generation, config/state routing, key material, request signing
- `registry/` - Agent registration, API keys, invites, admin bootstrap, CRL handling
- `connector/` - WebSocket connector client protocol + OS service install/uninstall
- `runtime/` - HTTP relay runtime, relay auth headers, replay/dead-letter helpers, trusted receipts
- `providers/` - Platform integrations (`openclaw`, `picoclaw`, `nanobot`, `nanoclaw`) + doctor/setup/relay-test
- `pairing/` - Peer pairing flows, ticket/QR handling, peer aliasing and snapshot sync

## CLI Commands Overview (`clawdentity-cli`)
- `init` - initialize local human identity and local state files
- `whoami` - print local identity (DID/public key/registry)
- `register` - fetch metadata + run legacy register flow status
- `config` - init/show/get/set config values (`registryUrl`, `proxyUrl`, `apiKey`, `humanName`)
- `agent` - create/inspect agent identities and refresh/revoke agent auth
- `api-key` - create/list/revoke registry API keys
- `invite` - create invite codes and redeem invites into local config
- `admin` - bootstrap initial admin identity + API key
- `connector` - run connector daemon or install/uninstall connector service
- `provider` - provider doctor/setup/relay-test/status
- `install` - platform auto-detect install flow (`openclaw`/`picoclaw`/`nanobot`/`nanoclaw`)

## Docs Index
Use docs in `docs/` as the system of record:
- `docs/ARCHITECTURE.md` - module boundaries, dependency graph, flows, schema, security model
- `docs/DESIGN_DECISIONS.md` - key architectural choices and tradeoffs
- `docs/GOLDEN_PRINCIPLES.md` - non-negotiable engineering rules and enforcement
- `docs/HARNESS_ACTION_PLAN.md` - active Harness rollout plan and phase goals

## Quality Rules
- Max Rust file size is 800 lines (enforced in `clawdentity-core/tests/structural.rs`).
- No `.unwrap()` outside tests (enforced in `clawdentity-core/tests/structural.rs`).
- Dependency direction constraints are enforced in `clawdentity-core/tests/structural.rs`:
  - `providers` cannot import `runtime`
  - `connector` cannot import `providers`

## Commit Rules
- Use descriptive commit messages with clear scope.
- Use `--no-verify` when instructed by the task.
- Keep one logical change per commit (avoid mixing unrelated changes).
