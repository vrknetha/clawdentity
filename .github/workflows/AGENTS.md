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
- Rust releases must publish the canonical installer manifest to R2 at `rust/latest.json` and stage immutable release assets under `rust/v<version>/`.
- Release automation must stage and publish these skill assets to R2:
  - `skill/v<version>/skill.md`
  - `skill/latest/skill.md`
- Any release job that runs `apps/landing/scripts/verify-skill-artifacts.mjs` must build `@clawdentity/openclaw-skill` and sync Rust-owned assets first (`pnpm -F @clawdentity/openclaw-skill build && pnpm -F @clawdentity/openclaw-skill run sync:rust-assets`).
- Any release job that builds Node-owned landing or skill artifacts must run its own `pnpm install --frozen-lockfile` after checkout; do not assume `node_modules` from another job.
- Installer verification in CI must exercise both paths:
  - manifest-driven latest install
  - explicit `CLAWDENTITY_VERSION` install against staged downloads base URL
- Release checksum files must contain bare archive names, never workspace-relative prefixes such as `dist/`.
- Always generate and publish SHA256 checksums.
- Keep release uploads idempotent (`overwrite_files` / clobber-safe behavior) so reruns replace assets cleanly.

## Landing Deploy Rules
- `deploy-landing-develop.yml` and `deploy-landing.yml` must keep Cloudflare Pages bootstrap behavior before deploy.
- Project mapping is strict:
  - `deploy-landing-develop.yml` -> `clawdentity-site-dev` (production branch `develop`)
  - `deploy-landing.yml` -> `clawdentity-site` (production branch `main`)
- Both landing deploy workflows must assert these built artifacts before running `pages deploy`:
  - `apps/landing/dist/skill.md`
  - `apps/landing/dist/install.sh`
  - `apps/landing/dist/install.ps1`
- Both landing deploy workflows must preserve the canonical installer defaults that point at `https://downloads.clawdentity.com`.
- The production landing workflow must also mirror latest assets into the R2 artifact bucket after the Pages deploy succeeds.
- Any workflow step that calls raw `wrangler r2 object put` must explicitly export `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, and it must pass `--remote` so CI writes to the real bucket instead of Wrangler's local target.
- The develop landing workflow must verify the dev Pages onboarding URLs after deploy.
- Keep production landing and runtime deploys separable, but if a combined production deploy workflow exists it must still preserve the runtime-first ordering before landing/artifact publish.

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
- Do not depend on GitHub Releases API for installer latest-version lookup; the workflow must publish a self-contained manifest consumed from `downloads.clawdentity.com`.

## Separation of Concerns
- Keep `.github/workflows/ci.yml` focused on validation gates.
- Keep `.github/workflows/publish-rust.yml` as the complete Rust release path.
- Do not add a second CLI publish workflow; all operator release concerns belong in `publish-rust.yml`.
