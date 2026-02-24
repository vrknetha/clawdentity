# AGENTS.md

## 1) Project Overview
Clawdentity is a mixed TypeScript + Rust monorepo that provides cryptographic identity and trusted relay infrastructure for agent-to-agent communication. The deployable surface is in `apps/` (registry, proxy, CLI packaging, OpenClaw skill), shared contracts/runtime libraries are in `packages/`, and Rust runtime + CLI implementation is in `crates/`. Design and delivery must assume operators may run Clawdentity in local or constrained/offline environments, with OpenClaw integration as a first-class workflow.

## 2) Build Commands

### TypeScript (apps + packages)
Run from repository root:
- `pnpm install`
- `pnpm build`
- `pnpm test`

## DID Format Guidance
- Keep all DID construction/parsing inside `packages/protocol/src/did.ts` so the switch to `did:cdi` stays centralized and tests update automatically.
- Trust slices (AIT, CRL, registry ownership, proxy pairings, connectors) should call shared helpers (e.g., `parseDid`, `validateAgentDid`) instead of copying brittle string-prefix checks; this keeps role expectations tied to context when DID semantics depend on parsed entity and authority fields.
- When new DID authorities appear (registry-owned vs self-hosted), track their identifiers in configuration and rely on parsed `authority` metadata for routing/trust checks rather than scattering hardcoded strings.

## Execution Governance
- GitHub issues are the source of truth for sequencing, blockers, and rollout updates.
- Primary execution tracker: https://github.com/vrknetha/clawdentity/issues/74.
- Do not use local execution-order files as governance source.

Common quality checks:
- `pnpm lint`
- `pnpm -r typecheck`
- `pnpm check:file-size`

### Rust (crates workspace)
Run from `crates/`:
- `cargo check`
- `cargo clippy --all-targets`
- `cargo test`
- `cargo build`

## 3) Module Map

### Apps (deployable services)
- `apps/registry` - Cloudflare Worker HTTP API for humans, agents, invites, API keys, and revocation data.
- `apps/proxy` - Cloudflare Worker relay/proxy that verifies Clawdentity auth headers and enforces trust policy.
- `apps/cli` - TypeScript CLI package (`clawdentity`) for onboarding, identity ops, provider setup, and skill install.
- `apps/openclaw-skill` - OpenClaw skill package and relay transform artifacts used by CLI install flow.

### Packages (shared libraries)
- `packages/protocol` - Canonical protocol models and signing/verification wire-contract definitions.
- `packages/common` - Shared utility layer (errors, helpers, validation glue, shared types).
- `packages/connector` - TypeScript connector client/runtime primitives for relay connectivity.
- `packages/sdk` - Developer SDK for identity operations, verification, auth flows, and integration helpers.

### Rust workspace crates
- `crates/clawdentity-core` - Core Rust library for identity, registry clients, connector/runtime, providers, pairing, and persistence.
- `crates/clawdentity-cli` - Rust CLI binary and command surface replacing the legacy TypeScript CLI over time.

### Rust local test services
- `crates/tests/local/mock-registry` - Local mock registry used for integration and harness-style flows.
- `crates/tests/local/mock-proxy` - Local mock relay/proxy used for integration and connector testing.

## 4) CLI Commands

### TypeScript CLI (`apps/cli`)
- Build/package: `pnpm -F clawdentity build`
- Common ops: `clawdentity config init`, `clawdentity invite redeem <code>`, `clawdentity agent create <name>`, `clawdentity openclaw setup <name>`, `clawdentity skill install`, `clawdentity connector start <name>`

### Rust CLI (`crates/clawdentity-cli`)
- Help: `cargo run -p clawdentity-cli -- --help`
- Common ops: `cargo run -p clawdentity-cli -- init`, `whoami`, `agent create <name>`, `invite redeem <code> --display-name <name>`, `connector start <agent>`, `provider doctor --for openclaw`

## 5) Deeper Docs
Use `docs/` as system of record:
- `docs/ARCHITECTURE.md` - end-to-end architecture across apps, packages, crates, and trust flows.
- `docs/MONOREPO.md` - workspace structure, dependency/build ordering, and cross-ecosystem testing strategy.
- `docs/DESIGN_DECISIONS.md` - architectural choices and tradeoffs.
- `docs/GOLDEN_PRINCIPLES.md` - non-negotiable quality constraints.
- `docs/HARNESS_ACTION_PLAN.md` - staged execution and quality-enforcement plan.

## 6) Quality Rules
- Follow `docs/GOLDEN_PRINCIPLES.md` for code and documentation changes.
- Keep modules small, testable, and dependency direction explicit.
- Favor actionable errors and stable machine-readable outputs.
- Run relevant TypeScript and Rust checks before commit (`pnpm build` and `cargo check` are baseline gates).
- Keep docs synchronized with implementation changes, especially when changing CLI flows or skill behavior.

## 7) Release Automation
- Keep Rust release automation in `.github/workflows/publish-rust.yml` as the single canonical path for version bump + crates.io publish + tag creation + binary release.
- Rust crate publish flow must derive next version from crates.io and keep `clawdentity-core` / `clawdentity-cli` versions aligned.
- Rust crate publish order is strict: publish `clawdentity-core` before `clawdentity-cli`.
- Rust binary builds must use the same `rust/vX.Y.Z` tag created by the crate publish flow.
- Rust binary releases must publish cross-platform assets for Windows x64, Linux x64/aarch64, and macOS x64/aarch64.
- Keep release asset names stable:
  - `clawdentity-<version>-linux-x86_64.tar.gz`
  - `clawdentity-<version>-linux-aarch64.tar.gz`
  - `clawdentity-<version>-macos-x86_64.tar.gz`
  - `clawdentity-<version>-macos-aarch64.tar.gz`
  - `clawdentity-<version>-windows-x86_64.zip`
  - `clawdentity-<version>-checksums.txt`
- Binary naming contract for release artifacts:
  - Unix binary is `clawdentity`
  - Windows binary is `clawdentity.exe`
- `irm`/PowerShell is a download/install path only; do not treat it as a runtime binary format.
- Every release run must publish SHA256 checksums for all archives.
