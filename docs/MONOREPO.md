# Clawdentity Monorepo Guide

## Why a Monorepo

Clawdentity keeps all service code, shared libraries, CLI surfaces, and Rust runtime in one repository so protocol and security changes ship coherently.

Primary reasons:
- shared identity/protocol contracts must stay consistent across registry, proxy, SDK, connector, and CLI implementations
- coordinated releases are simpler when TypeScript and Rust changes can be validated in one CI graph
- local/offline-friendly operator workflows require synchronized behavior between apps, packages, crates, and skill artifacts

## Workspace Layout

```text
apps/
  registry        # Cloudflare Worker API
  proxy           # Cloudflare Worker relay/proxy
  cli             # TypeScript CLI package
  openclaw-skill  # OpenClaw skill package

packages/
  protocol        # wire protocol definitions
  common          # shared utilities/types
  connector       # TypeScript connector client
  sdk             # developer SDK

crates/
  clawdentity-core  # Rust core runtime library
  clawdentity-cli   # Rust CLI binary
  tests/local/
    mock-registry   # Rust mock registry service
    mock-proxy      # Rust mock proxy service
```

## Package Manager and Task Orchestration

TypeScript ecosystem:
- package manager: `pnpm` workspaces
- orchestration: Nx (`nx run-many`, `nx affected`)
- root commands:
  - `pnpm install`
  - `pnpm build`
  - `pnpm test`
  - `pnpm -r typecheck`
  - `pnpm lint`

Rust ecosystem:
- package manager/build system: Cargo workspace in `crates/Cargo.toml`
- baseline commands:
  - `cargo check`
  - `cargo clippy --all-targets`
  - `cargo test`
  - `cargo build`

## Rust Workspace Integration

Rust workspace members are intentionally part of the same monorepo lifecycle, not a separate project.

Integration pattern:
- Rust core crate implements identity/connector/runtime/provider logic consumed by Rust CLI
- Rust mock services model registry/proxy behavior for local harness and integration testing
- protocol-level compatibility is kept aligned with TypeScript packages through shared docs, tests, and release coordination

## Build Order and Dependency Model

High-level dependency direction:

```text
packages/protocol
  -> packages/common
  -> packages/sdk
  -> packages/connector

apps/registry, apps/proxy, apps/cli, apps/openclaw-skill
  -> consume packages/*

crates/clawdentity-core
  -> independent Rust implementation of core identity/relay model
crates/clawdentity-cli
  -> depends on clawdentity-core
crates/tests/local/mock-*
  -> depend on clawdentity-core and shared Rust workspace deps
```

Practical build order for local development:
1. `pnpm install`
2. `pnpm build` (builds apps/packages graph)
3. `cd crates && cargo check`
4. optional full validation: `pnpm test` and `cd crates && cargo test`

## Coordinated Release Expectations

When protocol/auth behavior changes:
- update `packages/protocol` and any dependent TypeScript packages/apps
- update Rust implementation in `clawdentity-core`/`clawdentity-cli` as needed
- keep CLI UX and config semantics compatible during TS->Rust CLI transition
- document behavior changes in `docs/ARCHITECTURE.md` and `docs/DESIGN_DECISIONS.md`

## Testing Strategy Across Ecosystems

TypeScript validation:
- Vitest suites for apps/packages
- Hono app route tests via `app.request()` with mocked bindings
- Nx affected checks in CI for lint/format/typecheck/test/build

Rust validation:
- unit/integration tests via `cargo test`
- structural invariants enforced in Rust structural tests (file size, unwrap policy, dependency direction)
- local mock-registry and mock-proxy binaries for realistic relay scenarios

Cross-ecosystem baseline gates for this monorepo:
- `pnpm build`
- `cargo check`

These two commands must stay green after doc-only or code changes that touch repository structure, developer workflows, or architecture contracts.
