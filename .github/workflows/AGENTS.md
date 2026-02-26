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
  - `aarch64-pc-windows-msvc`
- Use only supported runner labels; avoid deprecated/unsupported macOS labels (for example `macos-13` if unavailable in project settings).
- Smoke-test binaries only on native runner/target pairs.
- Skip smoke execution for `aarch64-pc-windows-msvc` on `windows-latest` because the hosted runner is x64.
- Do not execute cross-built `linux-aarch64` artifacts on `ubuntu-latest` x86 runners; this must be skipped (exec format mismatch).
- When `x86_64-apple-darwin` is built on Apple Silicon runners, skip smoke execution unless a native Intel runner is configured.
- Keep binary naming stable in packaged archives:
  - Unix: `clawdentity`
  - Windows: `clawdentity.exe`
- Keep release asset naming stable:
  - `clawdentity-<version>-linux-x86_64.tar.gz`
  - `clawdentity-<version>-linux-aarch64.tar.gz`
  - `clawdentity-<version>-macos-x86_64.tar.gz`
  - `clawdentity-<version>-macos-aarch64.tar.gz`
  - `clawdentity-<version>-windows-x86_64.zip`
  - `clawdentity-<version>-windows-aarch64.zip`
  - `install.sh`
  - `install.ps1`
  - `clawdentity-<version>-checksums.txt`
- Installer script assets in Rust releases must be sourced from `apps/landing/public/install.sh` and `apps/landing/public/install.ps1`.
- Always generate and publish SHA256 checksums.
- Keep release uploads idempotent (`overwrite_files` / clobber-safe behavior) so reruns replace assets cleanly.

## Landing Deploy Rules
- `deploy-landing-develop.yml` and `deploy-landing.yml` must keep Cloudflare Pages bootstrap behavior before deploy.
- Both landing deploy workflows must assert these built artifacts before running `pages deploy`:
  - `apps/landing/dist/skill.md`
  - `apps/landing/dist/install.sh`
  - `apps/landing/dist/install.ps1`

## Rust Crate Publish Rules
- Resolve next version from crates metadata using `cargo info` and bump both crate manifests consistently:
  - `crates/clawdentity-core/Cargo.toml`
  - `crates/clawdentity-cli/Cargo.toml`
- Do not call crates.io API endpoints directly from release automation; use Cargo registry/index access paths.
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
