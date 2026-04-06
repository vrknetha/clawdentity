# AGENTS.md

## 1) Project Overview
Clawdentity is a mixed TypeScript + Rust monorepo that provides cryptographic identity and trusted relay infrastructure for agent-to-agent communication. The deployable surface is in `apps/` (registry, proxy, OpenClaw skill), shared contracts/runtime libraries are in `packages/`, and the canonical operator/runtime implementation is in `crates/`. Design and delivery must assume operators may run Clawdentity in local or constrained/offline environments, with OpenClaw integration as a first-class workflow.

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
- Keep group identifier parsing centralized in `packages/protocol/src/did.ts` via `parseGroupId` (`grp_<ULID>`); do not duplicate group-id parsing logic in services.

## Group Naming Guidance
- Use `group join token` as the canonical product/code/doc term.
- Do not use `group invite` naming for membership-scoped tokens.

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
- `apps/openclaw-skill` - OpenClaw skill package and relay transform artifacts used by CLI install flow.

### Packages (shared libraries)
- `packages/protocol` - Canonical protocol models and signing/verification wire-contract definitions.
- `packages/common` - Shared utility layer (errors, helpers, validation glue, shared types).
- `packages/connector` - TypeScript connector client/runtime primitives for relay connectivity.
- `packages/sdk` - Developer SDK for identity operations, verification, auth flows, and integration helpers.

### Rust workspace crates
- `crates/clawdentity-core` - Core Rust library for identity, registry clients, connector/runtime, providers, pairing, and persistence.
- `crates/clawdentity-cli` - Rust CLI binary and command surface for current operator workflows.

### Rust local test services
- `crates/tests/local/mock-registry` - Local mock registry used for integration and harness-style flows.
- `crates/tests/local/mock-proxy` - Local mock relay/proxy used for integration and connector testing.

## 4) CLI Commands

### Rust CLI (`crates/clawdentity-cli`)
- Help: `cargo run -p clawdentity-cli -- --help`
- Common ops: `cargo run -p clawdentity-cli -- init`, `register`, `whoami`, `agent create <name>`, `pair start <agent>`, `pair confirm <agent>`, `verify <token-or-file>`, `install --for <platform>`, `provider setup --for <platform> --agent-name <name>`, `provider doctor --for <platform>`, `connector start <agent>`

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
- Keep user onboarding docs prompt-first (`/skill.md` canonical); treat command-by-command and Rust toolchain flows as advanced fallback guidance only.

## 7) Local Prompt-First Testing Workflow
- When the user wants local OpenClaw testing through `skill.md`, build installable local release artifacts first, not just the host debug binary.
- When the user asks to "reset again and give prompts" after changing the Rust CLI, `apps/landing/public/install.sh`, or any `skill.md` content, first rebuild the local install surface (`apps/landing/public/rust/v<version>/`, `apps/landing/public/rust/latest-local.json`), then verify the real tunneled `/skill.md` before resetting containers and minting invite codes.
- For container/runtime installs, never copy the macOS host debug binary into Linux containers; use the Linux release archives under `apps/landing/public/rust/v<version>/`.
- The canonical local install surface for prompt-first testing is:
  - `apps/landing/public/skill.md`
  - `apps/landing/public/install.sh`
  - `apps/landing/public/rust/latest-local.json`
  - `apps/landing/public/rust/v<version>/clawdentity-<version>-linux-*.tar.gz`
- Prefer serving `apps/landing/public` with a plain static server for tunnel use (for example `python3 -m http.server 54321 --directory apps/landing/public`) instead of tunneling the Astro/Vite dev server, because host-allow rules can block localtunnel requests.
- Prefer exposing that static server with localtunnel and verify the real public URL returns HTTP `200` for `/skill.md` before giving prompts to the user.
- For local operator testing, mint fresh registry invite codes with the host CLI (`crates/target/debug/clawdentity-cli --json invite create`) and use those real codes in prompts.
- When the user asks for prompts, provide ready-to-paste prompts with the actual tunnel URL and actual invite codes. Do not leave placeholder replacement work unless the user explicitly asks for a template.
- Keep local prompt instructions simple: use the Clawdentity relay skill URL, tell the agent to set up Clawdentity for OpenClaw, install the CLI from the same origin if missing, and run onboarding with the real invite code, display name, and agent name.
- Do not add extra prompt lines about reusing existing `CLAWDENTITY_REGISTRY_URL` / `CLAWDENTITY_PROXY_URL` or waiting for `provider doctor` unless the user explicitly asks for that detail.

## 8) Release Automation
- Keep Rust release automation in `.github/workflows/publish-rust.yml` as the single canonical path for version bump + crates.io publish + tag creation + binary release.
- Rust crate publish flow must derive the next version from crates metadata via `cargo info`, avoid direct crates.io API endpoint calls, verify the new `rust/vX.Y.Z` tag does not yet exist, and keep `clawdentity-core` / `clawdentity-cli` versions aligned.
- Rust crate publish order is strict: publish `clawdentity-core` before `clawdentity-cli`.
- Rust binary builds must use the same `rust/vX.Y.Z` tag created by the crate publish flow.
- Rust binary releases must publish cross-platform assets for Windows x64, Linux x64/aarch64, and macOS x64/aarch64.
- Local harness-generated landing artifacts (`apps/landing/public/rust/latest-local.json` and `apps/landing/public/rust/v*/`) are ephemeral test outputs and must stay untracked in git.
- Keep release asset names stable:
  - `clawdentity-<version>-linux-x86_64.tar.gz`
  - `clawdentity-<version>-linux-aarch64.tar.gz`
  - `clawdentity-<version>-macos-x86_64.tar.gz`
  - `clawdentity-<version>-macos-aarch64.tar.gz`
  - `clawdentity-<version>-windows-x86_64.zip`
  - `clawdentity-<version>-windows-aarch64.zip`
  - `clawdentity-<version>-checksums.txt`
- Binary naming contract for release artifacts:
  - Unix binary is `clawdentity`
  - Windows binary is `clawdentity.exe`
- `irm`/PowerShell is a download/install path only; do not treat it as a runtime binary format.
- Every release run must publish SHA256 checksums for all archives.
