# AGENTS.md (.github/workflows)

## Purpose
- Define workflow-level guardrails for CI, release, and deployment automation.

## Rust Binary Release Rules
- `release-rust-binaries.yml` is the canonical workflow for Rust CLI binary releases.
- Keep this workflow operator-invokable via `workflow_dispatch`; it may also be called by `publish-rust.yml` through `workflow_call`.
- Validate release tag input format strictly as `rust/vX.Y.Z`; fail fast on invalid or missing tags.
- Build and publish these platform targets in every release:
  - `x86_64-unknown-linux-gnu`
  - `aarch64-unknown-linux-gnu`
  - `x86_64-apple-darwin`
  - `aarch64-apple-darwin`
  - `x86_64-pc-windows-msvc`
- Keep binary naming stable in packaged archives:
  - Unix: `clawdentity`
  - Windows: `clawdentity.exe`
- Keep release asset naming stable:
  - `clawdentity-<version>-linux-x86_64.tar.gz`
  - `clawdentity-<version>-linux-aarch64.tar.gz`
  - `clawdentity-<version>-macos-x86_64.tar.gz`
  - `clawdentity-<version>-macos-aarch64.tar.gz`
  - `clawdentity-<version>-windows-x86_64.zip`
  - `clawdentity-<version>-checksums.txt`
- Always generate and publish SHA256 checksums.
- Keep release uploads idempotent (`overwrite_files` / clobber-safe behavior) so reruns replace assets cleanly.

## Rust Crate Publish Rules
- `publish-rust.yml` is the canonical workflow for automated crates.io publishes.
- Resolve next version from crates.io and bump both crate manifests consistently:
  - `crates/clawdentity-core/Cargo.toml`
  - `crates/clawdentity-cli/Cargo.toml`
- Keep `clawdentity-cli` dependency on `clawdentity-core` version-locked to the same release version before publish.
- Publish order is strict:
  - first `clawdentity-core`
  - then `clawdentity-cli`
- Tag contract remains strict: `rust/vX.Y.Z`.
- After crate publish and tag creation, invoke `release-rust-binaries.yml` for the same tag so crates and binaries stay aligned.

## Separation of Concerns
- Keep `.github/workflows/ci.yml` focused on validation gates.
- Keep `.github/workflows/publish-cli.yml` focused on npm package publishing.
- Keep `.github/workflows/publish-rust.yml` focused on Cargo version/publish orchestration.
- Do not couple Rust release workflows with npm publish workflow.
