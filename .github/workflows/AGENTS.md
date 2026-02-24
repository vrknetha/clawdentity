# AGENTS.md (.github/workflows)

## Purpose
- Define workflow-level guardrails for CI, release, and deployment automation.

## Rust Binary Release Rules
- `release-rust-binaries.yml` is the canonical workflow for Rust CLI binary releases.
- Keep this workflow manual-only (`workflow_dispatch`) unless maintainers explicitly decide otherwise.
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

## Separation of Concerns
- Keep `.github/workflows/ci.yml` focused on validation gates.
- Keep `.github/workflows/publish-cli.yml` focused on npm package publishing.
- Do not couple Rust binary release workflow with npm publish workflow.
