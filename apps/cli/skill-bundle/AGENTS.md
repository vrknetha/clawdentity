# AGENTS.md (apps/cli/skill-bundle)

## Purpose
- Store bundled skill artifacts shipped with the CLI package for npm `--skill` postinstall.

## Rules
- Treat this folder as generated release input; do not hand-edit bundled files.
- Regenerate by running `pnpm -F @clawdentity/cli run sync:skill-bundle` after changes in `apps/openclaw-skill`.
- Required bundled files:
  - `openclaw-skill/skill/SKILL.md`
  - `openclaw-skill/skill/references/*`
  - `openclaw-skill/dist/relay-to-peer.mjs`
