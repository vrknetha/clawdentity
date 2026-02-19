# AGENTS.md (apps/cli/skill-bundle)

## Purpose
- Store bundled skill artifacts shipped with the CLI package for `clawdentity skill install`.

## Rules
- Treat this folder as generated release input; do not hand-edit bundled files.
- Keep `openclaw-skill/` generated-only and gitignored; commit only this `AGENTS.md`.
- Regenerate by running `pnpm -F @clawdentity/openclaw-skill build && pnpm -F clawdentity run sync:skill-bundle`.
- Required bundled files:
  - `openclaw-skill/skill/SKILL.md`
  - `openclaw-skill/skill/references/*`
  - `openclaw-skill/dist/relay-to-peer.mjs`
