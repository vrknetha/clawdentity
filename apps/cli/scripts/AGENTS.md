# AGENTS.md (apps/cli/scripts)

## Purpose
- Keep CLI helper scripts deterministic and safe for release packaging.

## Rules
- `sync-skill-bundle.mjs` is the source of truth for copying OpenClaw skill assets into `apps/cli/skill-bundle/`.
- `sync-skill-bundle.mjs` must copy only from built source artifacts (`apps/openclaw-skill/dist/relay-to-peer.mjs`) and never fallback to stale bundled copies.
- `verify-skill-bundle.mjs` must validate the exact artifacts required by npm `--skill` install flow.
- Scripts must fail with actionable errors when required source artifacts are missing.
- Keep script output concise and stable for CI/release logs.
- Do not add install-time network fetches to packaging scripts.
