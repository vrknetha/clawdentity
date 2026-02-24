# AGENTS.md (.github/workflows)

## Purpose
- Define workflow-level guardrails for CI, release, and deployment automation.

## Rust Release Rules
- `publish-rust.yml` is the single canonical workflow for Rust releases (crate publish + binary release).
- Keep release operation manual (`workflow_dispatch`) with `release_type`, `draft`, and `prerelease` controls.
- Tag contract must stay strict: `rust/vX.Y.Z`.
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
- Resolve next version from crates.io and bump both crate manifests consistently:
  - `crates/clawdentity-core/Cargo.toml`
  - `crates/clawdentity-cli/Cargo.toml`
- Keep `clawdentity-cli` dependency on `clawdentity-core` version-locked to the same release version before publish.
- Publish order is strict:
  - first `clawdentity-core`
  - then `clawdentity-cli`
- After crate publish and tag creation, build binaries from that same tag so crates and binaries stay aligned.

## Separation of Concerns
- Keep `.github/workflows/ci.yml` focused on validation gates.
- Keep `.github/workflows/publish-cli.yml` focused on npm package publishing.
- Keep `.github/workflows/publish-rust.yml` as the complete Rust release path.
- Do not couple Rust release workflows with npm publish workflow.
