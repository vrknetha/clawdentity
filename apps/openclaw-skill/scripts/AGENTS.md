# AGENTS.md (apps/openclaw-skill/scripts)

## Purpose
- Keep OpenClaw skill asset sync scripts deterministic and release-safe.

## Rules
- `sync-rust-assets.mjs` is the only script that projects source skill assets into `crates/clawdentity-core/assets/openclaw-skill/`.
- Always copy from source-controlled skill files and built transform output; do not read from deleted JS CLI bundles.
- Keep output paths stable so `publish-rust.yml` and `verify-skill-artifacts.mjs` stay aligned.
