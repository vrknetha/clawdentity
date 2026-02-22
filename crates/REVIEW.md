# Rust CLI Review (`develop...feat/rust-cli`)

## Scope Checked
- Ran: `git diff develop...feat/rust-cli --stat`
- Ran: `cargo check --manifest-path crates/Cargo.toml` (pass)
- Ran: `cargo test --manifest-path crates/Cargo.toml` (pass; `clawdentity-cli` 1 test, `clawdentity-core` 56 tests)

## Findings

### Critical
1. CLI contract parity is broken at the entrypoint and top-level command surface.
   - Rust binary/CLI name is `clawdentity`, not `clawdentity` (`crates/clawdentity-cli/src/main.rs:24`, `apps/cli/src/index.ts:32`).
   - Rust top-level commands omit `pair`, `skill`, and `verify` (`crates/clawdentity-cli/src/main.rs:35`, `apps/cli/src/index.ts:42`).

2. `agent revoke` parity is missing, and the exposed alternative is a stub.
   - TypeScript exposes `agent revoke <name>` (`apps/cli/src/commands/agent/command.ts:171`).
   - Rust exposes `agent auth revoke <name>` instead (`crates/clawdentity-cli/src/main.rs:109`) and returns `not_supported` (`crates/clawdentity-core/src/agent.rs:662`).
   - Impact: revocation automation cannot be ported safely.

3. Connector/OpenClaw operational parity is incomplete for runtime startup flows.
   - TypeScript exposes `connector start` (`apps/cli/src/commands/connector/command.ts:27`); Rust connector command only has `service` (`crates/clawdentity-cli/src/commands/connector.rs:9`).
   - TypeScript `openclaw setup` includes runtime startup/check options (`apps/cli/src/commands/openclaw/command.ts:44`) and actually performs readiness/startup flow (`apps/cli/src/commands/openclaw/setup.ts:315`).
   - Rust `openclaw setup` currently only persists local state files (`crates/clawdentity-cli/src/main.rs:538`).

### Medium
1. Missing error handling: `config init` silently ignores registry metadata fetch failures.
   - Rust swallows fetch errors with `if let Ok(metadata)` (`crates/clawdentity-cli/src/main.rs:340`) and still prints success (`crates/clawdentity-cli/src/main.rs:356`).
   - TypeScript treats metadata fetch as required and fails on errors (`apps/cli/src/commands/config.ts:119`).

2. CLI test coverage is far below TypeScript parity expectations.
   - `clawdentity-cli` has only clap wiring validation (`crates/clawdentity-cli/src/main.rs:751`).
   - No command-behavior tests for output, exit codes, or HTTP error mapping that TS CLI already covers (e.g. `apps/cli/src/commands/api-key.test.ts:265`, `apps/cli/src/commands/invite.test.ts:297`, `apps/cli/src/commands/pair.test/output.test.ts:20`).

### Low
1. Runtime status endpoint masks DB read failures as zero counts.
   - `unwrap_or(0)` on DB counters can hide degraded state (`crates/clawdentity-core/src/runtime_server.rs:76`).

2. Legacy `register` command is exposed but intentionally non-functional.
   - Command is wired in CLI (`crates/clawdentity-cli/src/main.rs:41`), while implementation always returns `not_supported` (`crates/clawdentity-core/src/registry.rs:74`).
