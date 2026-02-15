# AGENTS.md (apps/proxy)

## Purpose
- Define conventions for the Clawdentity proxy app.
- Keep runtime config, auth boundaries, and forwarding behavior consistent across tickets.

## Runtime Configuration
- Keep runtime config centralized in `src/config.ts`.
- Parse config with a schema and fail fast with `CONFIG_VALIDATION_FAILED` before startup proceeds.
- Keep defaults explicit for non-secret settings (`listenPort`, `openclawBaseUrl`, `registryUrl`, CRL timings, stale behavior).
- Keep runtime `ENVIRONMENT` explicit and validated to supported values: `local`, `development`, `production`, `test` (default `development`).
- Require hook token input via env (`OPENCLAW_HOOK_TOKEN` or OpenClaw-compatible alias `OPENCLAW_HOOKS_TOKEN`) and never log the token value.
- Load env files with OpenClaw precedence and no overrides:
  - first `./.env` from the proxy working directory
  - then `$OPENCLAW_STATE_DIR/.env` (or default state dir: `~/.openclaw`, with legacy fallback to existing `~/.clawdbot` / `~/.moldbot` / `~/.moltbot`)
  - existing environment variables always win over `.env` values.
- Treat blank env values as unset for fallback resolution:
  - empty/whitespace values (and null-like values) in inherited env must not block `.env` or config-file fallbacks
  - dotenv merge semantics must match parser semantics (non-empty value wins).
- If hook token env vars are missing, resolve fallback token from `hooks.token` in `openclaw.json` (`OPENCLAW_CONFIG_PATH`/`CLAWDBOT_CONFIG_PATH`, default `$OPENCLAW_STATE_DIR/openclaw.json`).
- Keep env alias support stable for operator UX:
  - `LISTEN_PORT` or `PORT`
  - `OPENCLAW_HOOK_TOKEN` or `OPENCLAW_HOOKS_TOKEN`
  - `REGISTRY_URL` or `CLAWDENTITY_REGISTRY_URL`
  - state/config path aliases: `OPENCLAW_STATE_DIR`/`CLAWDBOT_STATE_DIR`, `OPENCLAW_CONFIG_PATH`/`CLAWDBOT_CONFIG_PATH`

## Allowlist and Access
- Keep allowlist shape as `{ owners: string[], agents: string[], allowAllVerified: boolean }`.
- Allow bootstrap from `ALLOW_LIST` JSON with optional explicit overrides (`ALLOWLIST_OWNERS`, `ALLOWLIST_AGENTS`, `ALLOW_ALL_VERIFIED`).
- Keep allowlist parsing deterministic and reject malformed input with structured config errors.

## CRL Policy
- Keep CRL timing defaults explicit in `src/config.ts` (`5m` refresh, `15m` max age) unless explicitly overridden.
- Keep stale policy explicit (`fail-open` or `fail-closed`) and configurable from env.

## Testing Rules
- Cover both config happy paths and failure paths in `src/config.test.ts`.
- Keep startup tests in `src/index.test.ts` to verify runtime initialization fails when config is invalid.
- Keep server route/middleware behavior in `src/server.test.ts` (`GET /health`, request id propagation, and structured request logging).
- Keep tests offline and deterministic (no network, no filesystem dependency).

## Server Runtime
- Keep `src/server.ts` as the HTTP app/runtime entry.
- Keep middleware order stable: request context -> request logging -> error handler.
- Keep `/health` response contract stable: `{ status, version, environment }` with HTTP 200.
- Log startup and request completion with structured JSON logs; never log secrets or tokens.
