# AGENTS.md (apps/landing/scripts)

## Purpose
- Keep landing build and release helper scripts deterministic and safe for CI/release automation.

## Rules
- `build-skill-md.mjs` is the only supported generator for `apps/landing/public/agent-skill.md` and `apps/landing/public/skill.md`.
- `build-skill-md.mjs` must derive artifacts directly from `apps/agent-skill/skill/SKILL.md`.
- `build-skill-md.mjs` may rewrite the canonical site origin only when `CLAWDENTITY_SITE_BASE_URL` is explicitly set for local preview/testing; release and CI paths must keep `https://clawdentity.com`.
- `create-release-manifest.mjs` is the source of truth for the installer manifest contract:
  - `version`
  - `tag`
  - `publishedAt`
  - `assetBaseUrl`
  - `checksumsUrl`
  - platform asset URLs
- `verify-skill-artifacts.mjs` must fail fast when the landing skill artifact drifts from the source skill or the CLI bundle drifts from the source skill tree.
- Keep these scripts Node-only and dependency-light so release workflows can run them without a full workspace install.
