# AGENTS.md (crates/clawdentity-core/assets)

## Purpose
- Define rules for assets shipped inside the Rust release.

## Rules
- `openclaw-skill/` is generated from `apps/openclaw-skill` source files plus built transform output.
- Do not hand-edit copied skill assets in this folder. Regenerate them via `pnpm -F @clawdentity/openclaw-skill build && pnpm -F @clawdentity/openclaw-skill run sync:rust-assets`.
- Keep asset paths stable so `clawdentity install --for openclaw` and release verification stay deterministic.
