# AGENTS.md (crates/clawdentity-cli)

## Purpose
- Keep Rust CLI crate manifests and publish workflow deterministic for crates.io and binary release pipelines.

## Cargo Manifest Rules
- Keep `[package]` metadata publish-ready: `name`, `version`, `description`, `license`, and `repository`.
- Keep `readme` path valid from this crate directory.
- For any internal dependency that can be published, always include an explicit `version` with `path` (for example `clawdentity-core = { version = "...", path = "../clawdentity-core" }`).
- Run `cargo publish --dry-run -p clawdentity-cli` before any publish action.

## Release Alignment
- CLI crate version must align with the release tag used in GitHub release workflow (`rust/vX.Y.Z`).
- Do not introduce Node/TypeScript-only release instructions in this crate; Rust release flow is canonical.
