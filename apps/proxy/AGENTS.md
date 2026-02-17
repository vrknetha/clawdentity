# AGENTS.md (apps/proxy)

## Purpose
- Define conventions for the Clawdentity proxy app.
- Keep runtime config, auth boundaries, and forwarding behavior consistent across tickets.

## Runtime Configuration
- Keep runtime config centralized in `src/config.ts`.
- Keep Cloudflare Worker deployment config in `wrangler.jsonc` with explicit `local`, `development`, and `production` environments.
- Parse config with a schema and fail fast with `CONFIG_VALIDATION_FAILED` before startup proceeds.
- Keep defaults explicit for non-secret settings (`listenPort`, `openclawBaseUrl`, `registryUrl`, CRL timings, stale behavior).
- Keep agent DID limiter defaults explicit in `src/config.ts` (`AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE=60`, `AGENT_RATE_LIMIT_WINDOW_MS=60000`) unless explicitly overridden.
- Keep runtime `ENVIRONMENT` explicit and validated to supported values: `local`, `development`, `production`, `test` (default `development`).
- Keep deployment intent explicit: `local` is for local Wrangler dev runs only; `development` and `production` are remote cloud environments.
- Keep `INJECT_IDENTITY_INTO_MESSAGE` explicit and default-on (`true`); disable only when operators need unchanged webhook `message` forwarding.
- Keep OpenClaw env inputs (`OPENCLAW_BASE_URL`, `OPENCLAW_HOOK_TOKEN` / `OPENCLAW_HOOKS_TOKEN`) backward-compatible but optional for relay-mode startup.
- Keep `.dev.vars` and `.env.example` synchronized when adding/changing proxy config fields (registry URL, optional OpenClaw compatibility vars, and policy/rate-limit vars).
- Load env files with OpenClaw precedence and no overrides:
  - first `./.env` from the proxy working directory
  - then `$OPENCLAW_STATE_DIR/.env` (or default state dir: `~/.openclaw`, with legacy fallback to existing `~/.clawdbot` / `~/.moldbot` / `~/.moltbot`)
  - existing environment variables always win over `.env` values.
- If `OPENCLAW_BASE_URL` is still missing after env loading, fallback to `~/.clawdentity/openclaw-relay.json` (`openclawBaseUrl`) before applying the built-in default.
- Treat blank env values as unset for fallback resolution:
  - empty/whitespace values (and null-like values) in inherited env must not block `.env` or config-file fallbacks
  - dotenv merge semantics must match parser semantics (non-empty value wins).
- If hook token env vars are missing, resolve fallback token from `hooks.token` in `openclaw.json` (`OPENCLAW_CONFIG_PATH`/`CLAWDBOT_CONFIG_PATH`, default `$OPENCLAW_STATE_DIR/openclaw.json`).
- Route relay sessions via Durable Objects:
  - `GET /v1/relay/connect` keys connector sessions by authenticated caller agent DID.
  - `POST /hooks/agent` keys recipient delivery by `x-claw-recipient-agent-did`.
  - Do not route sessions via `OWNER_AGENT_DID`.
- Keep env alias support stable for operator UX:
  - `LISTEN_PORT` or `PORT`
  - `OPENCLAW_HOOK_TOKEN` or `OPENCLAW_HOOKS_TOKEN`
  - `REGISTRY_URL` or `CLAWDENTITY_REGISTRY_URL`
  - state/config path aliases: `OPENCLAW_STATE_DIR`/`CLAWDBOT_STATE_DIR`, `OPENCLAW_CONFIG_PATH`/`CLAWDBOT_CONFIG_PATH`

## Allowlist and Access
- Keep allowlist shape as `{ owners: string[], agents: string[] }`.
- Allow bootstrap from `ALLOW_LIST` JSON with optional explicit overrides (`ALLOWLIST_OWNERS`, `ALLOWLIST_AGENTS`).
- Keep allowlist parsing deterministic and reject malformed input with structured config errors.
- Reject deprecated `ALLOW_ALL_VERIFIED` at startup; never provide a global allow-all bypass for verified callers.

## Auth Verification
- Protect all non-health routes with Clawdentity auth verification middleware.
- Keep `GET /health` unauthenticated for probes and deployment checks.
- Parse inbound identity token strictly as `Authorization: Claw <AIT>`; do not accept Bearer or alternate token headers.
- Reject malformed authorization values that contain extra segments beyond `Claw <AIT>`.
- Reject malformed `X-Claw-Timestamp` values; accept only plain unix-seconds integer strings.
- Verify request pipeline order as: AIT -> timestamp skew -> PoP signature -> nonce replay -> CRL revocation.
- Enforce proxy access by explicit agent DID allowlist after auth verification; owner DID-only entries do not grant access.
- When AIT verification fails with unknown `kid`, refresh registry keyset once and retry verification before returning `401`.
- When CRL verification fails with unknown `kid`, refresh registry keyset once and retry verification before returning dependency failure.
- Return `401` for invalid/expired/replayed/revoked/invalid-proof requests.
- Return `403` when requests are verified but agent DID is not allowlisted.
- Return `429` with `PROXY_PUBLIC_RATE_LIMIT_EXCEEDED` when repeated unauthenticated probes exceed public-route IP budget.
- Return `429` with `PROXY_RATE_LIMIT_EXCEEDED` when an allowlisted verified agent DID exceeds its request budget within the configured window.
- Return `503` when registry keyset dependency is unavailable, and when CRL dependency is unavailable under `fail-closed` stale policy.
- Keep `/hooks/agent` runtime auth contract strict: require `x-claw-agent-access` and map missing/invalid access credentials to `401`.
- Keep `/v1/relay/connect` auth strict with verified Claw auth + PoP headers, but do not require `x-claw-agent-access`.

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
- Keep `src/worker.ts` as the Cloudflare Worker fetch entry and `src/node-server.ts` as the Node compatibility entry.
- Keep `AgentRelaySession` exported from `src/worker.ts` and bound/migrated in `wrangler.jsonc`.
- Keep middleware order stable: request context -> request logging -> public-route IP rate limit -> auth verification -> agent DID rate limit -> error handler.
- Keep `/health` response contract stable: `{ status, version, environment }` with HTTP 200.
- Log startup and request completion with structured JSON logs; never log secrets or tokens.
- If identity injection is enabled, mutate only `payload.message` when it is a string; preserve all other payload fields unchanged.
