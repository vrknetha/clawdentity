# AGENTS.md (scripts/env)

## Scope
- Applies to environment sync scripts under `scripts/env`.

## Rules
- Keep generated local `.env` files aligned with real runtime needs for local developer flows.
- Optional onboarding values that affect local OAuth testing (`LANDING_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_OAUTH_STATE_SECRET`) must be propagated when present, not hardcoded elsewhere.
- Do not write secret defaults into the sync script; only copy values from the shared env source.
- Remove retired env aliases promptly from both `.env.example` and sync lists so local setups expose one canonical variable name per behavior.
