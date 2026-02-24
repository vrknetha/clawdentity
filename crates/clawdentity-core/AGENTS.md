# AGENTS.md (crates/clawdentity-core)

## Purpose
- Keep core Rust crate publishable and stable for downstream CLI consumers.

## Cargo Manifest Rules
- Maintain publish metadata in `[package]`: `name`, `version`, `description`, `license`, `repository`.
- Keep `readme` path valid and relative to this crate.
- When changing public API used by `clawdentity-cli`, update versions and verify dependency compatibility.
- Run `cargo publish --dry-run -p clawdentity-core` before release/publish decisions.

## Compatibility Rules
- Treat this crate as the canonical Rust implementation for identity, relay, connector, and provider behavior.
- Avoid breaking changes without coordinated CLI update and release notes.
