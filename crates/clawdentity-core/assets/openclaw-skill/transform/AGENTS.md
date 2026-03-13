# AGENTS.md (crates/clawdentity-core/assets/openclaw-skill/transform)

## Purpose
- Guard the generated relay transform bundle shipped inside Rust releases.

## Rules
- This folder is generated from `/Users/dev/Workdir/clawdentity/apps/openclaw-skill/src/transforms/relay-to-peer.ts`; do not hand-edit `relay-to-peer.mjs`.
- Regenerate this bundle with `pnpm -F @clawdentity/openclaw-skill build && pnpm -F @clawdentity/openclaw-skill run sync:rust-assets`.
- Runtime override behavior must stay aligned with Rust setup output:
  - explicit connector base URLs stay exact
  - absolute `peersConfigPath` values are honored
  - relative `peersConfigPath` values stay relative to `hooks/transforms/`
