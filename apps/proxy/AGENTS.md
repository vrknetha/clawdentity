# AGENTS.md (apps/proxy)

## Purpose
- Define conventions for the Clawdentity proxy app.
- Keep runtime config, auth boundaries, and forwarding behavior consistent across tickets.

## Runtime Configuration
- Keep runtime config centralized in `src/config.ts`.
- Keep Cloudflare Worker deployment config in `wrangler.jsonc` with explicit `local`, `dev`, and `production` environments.
- Duplicate Durable Object `bindings` and `migrations` inside each Wrangler env block; env sections do not inherit top-level DO config.
- Keep deploy traceability explicit by passing `APP_VERSION` (or fallback `PROXY_VERSION`) via Worker bindings; `/health` must surface the resolved version.
- Keep Wrangler observability logging enabled (`observability.enabled=true`, `logs.enabled=true`) so relay/auth failures are visible in Cloudflare logs.
- Production must keep `invocation_logs=false` to reduce noisy request-volume logs while preserving structured warn/error events.
- Keep `worker-configuration.d.ts` committed and regenerate with `CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false wrangler types --env dev` (or `pnpm -F @clawdentity/proxy run types:dev`) after `wrangler.jsonc` or binding changes.
- Keep `src/worker.ts` in module-worker shape: export the fetch handler as the default export when this Worker owns Durable Objects, and keep any named `worker` export only as a test convenience.
- Parse config with a schema and fail fast with `CONFIG_VALIDATION_FAILED` before startup proceeds.
- Keep defaults explicit for non-secret settings (`listenPort`, `openclawBaseUrl`, `registryUrl`, CRL timings, stale behavior).
- Keep agent DID limiter defaults explicit in `src/config.ts` (`AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE=60`, `AGENT_RATE_LIMIT_WINDOW_MS=60000`) unless explicitly overridden.
- Keep runtime `ENVIRONMENT` explicit and validated to supported values: `local`, `development`, `production` (default `development`).
- Keep deployment intent explicit: Wrangler `dev` maps to runtime `ENVIRONMENT=development`; `local` is for local Wrangler dev runs only, and `production` is the live cloud environment.
- Keep script intent explicit: `pnpm -F @clawdentity/proxy run dev` must run Wrangler with `--env dev --port 8787`, and `dev:local` is the only script that should run `--env local --port 8787`.
- Keep trust-store backend policy environment-scoped:
  - `local`: allow in-memory trust-store fallback when `PROXY_TRUST_STATE` binding is unavailable.
  - `development` and `production`: require `PROXY_TRUST_STATE`; fail startup when missing.
- Keep `INJECT_IDENTITY_INTO_MESSAGE` explicit and default-on (`true`); disable only when operators need unchanged webhook `message` forwarding.
- Keep OpenClaw base URL input (`OPENCLAW_BASE_URL`) optional for relay-mode startup.
- Keep `.dev.vars` and `.env.example` synchronized when adding/changing proxy config fields (registry URL, optional OpenClaw base URL, and policy/rate-limit vars).
- Generate local `apps/proxy/.env` via `pnpm env:sync` (source `~/.clawdentity/worktree.env`) instead of manual edits.
- Load env files with OpenClaw precedence and no overrides:
  - first `./.env` from the proxy working directory
  - then `$OPENCLAW_STATE_DIR/.env` (or default state dir: `~/.openclaw`)
  - existing environment variables always win over `.env` values.
- If `OPENCLAW_BASE_URL` is still missing after env loading, fallback to `~/.clawdentity/openclaw-relay.json` (`openclawBaseUrl`) before applying the built-in default.
- Treat blank env values as unset for fallback resolution:
  - empty/whitespace values (and null-like values) in inherited env must not block `.env` or config-file fallbacks
  - dotenv merge semantics must match parser semantics (non-empty value wins).
- Do not read or require `OPENCLAW_HOOK_TOKEN` in proxy runtime; that token is connector-side only.
- Route relay sessions via Durable Objects:
  - `GET /v1/relay/connect` keys connector sessions by authenticated caller agent DID.
  - `POST /hooks/agent` keys recipient delivery by `x-claw-recipient-agent-did`.
  - Do not route sessions via `OWNER_AGENT_DID`.
- Keep env input contract explicit for operator UX:
  - `LISTEN_PORT` or `PORT`
  - `OPENCLAW_BASE_URL`
  - `REGISTRY_URL` or `CLAWDENTITY_REGISTRY_URL`
  - `BOOTSTRAP_INTERNAL_SERVICE_ID` + `BOOTSTRAP_INTERNAL_SERVICE_SECRET` (required together for proxy-to-registry identity ownership checks)
  - `OPENCLAW_STATE_DIR`
  - `RELAY_QUEUE_MAX_MESSAGES_PER_AGENT`, `RELAY_QUEUE_TTL_SECONDS`, `RELAY_RETRY_INITIAL_MS`, `RELAY_RETRY_MAX_MS`, `RELAY_RETRY_MAX_ATTEMPTS`, `RELAY_RETRY_JITTER_RATIO`

## Trust and Pairing
- Keep trust state in Durable Objects (`ProxyTrustState`), not in static environment variables.
- Do not add support for `ALLOW_LIST`, `ALLOWLIST_OWNERS`, or `ALLOWLIST_AGENTS`; trust is API-managed only.
- Pairing is managed by API:
  - `POST /pair/start` (verified Claw auth + internal ownership check via registry `/internal/v1/identity/agent-ownership`)
  - `POST /pair/confirm` (verified Claw auth + one-time pairing ticket consume)
- Pairing flow is single-proxy only: `POST /pair/confirm` must consume local tickets from trust state and never forward confirm requests.
- Keep `/pair/confirm` as a single trust-store operation that establishes trust and consumes the ticket in one step (`confirmPairingTicket`), never two separate calls.
- Confirming a valid pairing ticket must establish mutual trust for the initiator/responder agent pair.
- Keep pairing tickets one-time and expiring; reject missing/expired/malformed tickets with explicit client errors.
- Normalize pairing ticket expiry to whole seconds when persisting trust state (`exp` is second-granularity in ticket payload); do not reject valid tickets due millisecond offsets.
- Keep pairing fail-closed: do not bypass registry ownership dependency.
- Keep strict dependency enforcement as the default for `development` and `production`; do not infer bypass from hostnames.
- Reject deprecated `ALLOW_ALL_VERIFIED` at startup; never provide a global allow-all bypass for verified callers.

## Auth Verification
- Protect all non-health routes with Clawdentity auth verification middleware.
- Keep `GET /health` unauthenticated for probes and deployment checks.
- Parse inbound identity token strictly as `Authorization: Claw <AIT>`; do not accept Bearer or alternate token headers.
- Reject malformed authorization values that contain extra segments beyond `Claw <AIT>`.
- Reject malformed `X-Claw-Timestamp` values; accept only plain unix-seconds integer strings.
- Verify request pipeline order as: AIT -> timestamp skew -> PoP signature -> nonce replay -> CRL revocation.
- Enforce known-agent access from durable trust state after auth verification (except pairing bootstrap paths).
- When AIT verification fails with unknown `kid`, refresh registry keyset once and retry verification before returning `401`.
- When CRL verification fails with unknown `kid`, refresh registry keyset once and retry verification before returning dependency failure.
- Return `401` for invalid/expired/replayed/revoked/invalid-proof requests.
- Return `403` when requests are verified but caller is not trusted.
- Return `429` with `PROXY_PUBLIC_RATE_LIMIT_EXCEEDED` when repeated unauthenticated probes exceed public-route IP budget.
- Return `429` with `PROXY_RATE_LIMIT_EXCEEDED` when a trusted verified agent DID exceeds its request budget within the configured window.
- Return `503` when registry keyset dependency is unavailable, and when CRL dependency is unavailable under `fail-closed` stale policy.
- Keep `/hooks/agent` runtime auth contract strict: require `x-claw-agent-access` and map missing/invalid access credentials to `401`.
- Keep `/hooks/agent` authorization strict: after auth succeeds, require trusted initiator/responder pair before relay delivery.
- Keep `/hooks/agent` delivery contract async-first: accepted deliveries return `202` with delivery state (`delivered` or `queued`), not `502` for transient recipient offline cases.
- Keep queue overflow behavior explicit and stable: return `507 PROXY_RELAY_QUEUE_FULL` and preserve existing queued deliveries.
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
- Keep `/health` top-level response fields stable: `{ status, version, environment }` with HTTP 200.
- Additive readiness fields are allowed and expected:
  - top-level `ready`
  - `readiness.versionSource`
  - binding/config readiness booleans for registry URL, internal service credentials, relay session namespace, trust state binding, and OpenClaw base URL
- Log startup and request completion with structured JSON logs; never log secrets or tokens.
- Production request logging should emit only slow or failing requests; do not restore verbose success-path request logs in production.
- If identity injection is enabled, mutate only `payload.message` when it is a string; preserve all other payload fields unchanged.
