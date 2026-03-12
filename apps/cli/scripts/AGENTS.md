# AGENTS.md (apps/cli/scripts)

## Purpose
- Keep CLI helper scripts deterministic and safe for release packaging.

## Rules
- `sync-skill-bundle.mjs` is the source of truth for copying OpenClaw skill assets into `apps/cli/skill-bundle/`.
- `sync-skill-bundle.mjs` must copy only from built source artifacts (`apps/openclaw-skill/dist/relay-to-peer.mjs`) and never fallback to stale bundled copies.
- `verify-skill-bundle.mjs` must validate the exact artifacts required by `clawdentity skill install`.
- Bundle verification must require the full released skill surface:
  - `skill/SKILL.md`
  - `skill/references/clawdentity-protocol.md`
  - `skill/references/clawdentity-registry.md`
  - `skill/references/clawdentity-environment.md`
  - `dist/relay-to-peer.mjs`
- `openclaw-relay-docker-ready.sh` is the only Docker local-test entrypoint:
  - Restore alpha/beta profiles from pre-skill baselines (`alpha-kimi-preskill`, `beta-kimi-preskill` by default).
  - Preserve existing `.env` files by default (`PRESERVE_ENV=1`) so model API keys remain configured.
  - Enforce gateway safety defaults (`gateway.mode=local`, `bind=lan`, `controlUi.allowInsecureAuth=true`) and ensure auth tokens exist.
  - Resolve UI tokenized URLs with env-first precedence (`OPENCLAW_GATEWAY_TOKEN` from profile `.env`, then `openclaw.json`) to avoid token drift.
  - Persist generated gateway token back into each profile `.env` when missing so restarts remain deterministic.
  - Always upsert `CLAWDENTITY_REGISTRY_URL` and `CLAWDENTITY_PROXY_URL` into each profile `.env` for container runtime (`host.docker.internal` defaults) so invite redemption and setup do not fall back to production endpoints.
  - UI readiness must use HTTP success probes (not brittle HTML marker matching) with container-log diagnostics on timeout.
  - Remove any `clawdentity` package/skill residue from workspace plus clear sessions and memory DB, so testing always starts at skill installation.
- Scripts must fail with actionable errors when required source artifacts are missing.
- Keep script output concise and stable for CI/release logs.
- Do not add install-time network fetches to packaging scripts.
