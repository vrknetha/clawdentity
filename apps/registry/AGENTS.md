# AGENTS.md (apps/registry)

## Purpose
- Define registry app conventions for Cloudflare Worker runtime and Wrangler configuration.
- Keep deployment, domains, and rollback flow consistent across environments.

## Wrangler Configuration
- Use `wrangler.jsonc` as the source of truth for worker config.
- Keep `dev` and `production` environments explicit and isolated in config.
- Keep D1 database IDs version-controlled; manage secrets with `wrangler secret put`.
- Keep `migrations_dir` aligned with Drizzle output directory (`drizzle`).
- Prefer branded custom domains over `*.workers.dev` for public endpoints.
  - Development: `dev.api.clawdentity.com`
  - Production: `api.clawdentity.com`

## Deployment Rules
- Always deploy with explicit environment: `--env dev` or `--env production`.
- Deploy scripts must run D1 migrations before Worker deployment.
- For local development, run local migrations before `wrangler dev --env dev` (use `pnpm -F @clawdentity/registry run dev:local`).
- Verify `GET /health` returns `status: "ok"` and environment (`development` or `production`).

## Runtime and API
- Preserve `/health` response contract: `{ status, version, environment }`.
- Keep the worker entrypoint in `src/server.ts`; use `src/index.ts` only as the package export wrapper.
- Keep environment variables non-secret in `wrangler.jsonc` and secret values out of git.

## Validation
- Validate config changes with `wrangler check` before deployment.
- Run `pnpm -F @clawdentity/registry run test` and `pnpm -F @clawdentity/registry run typecheck` for app-level safety.
- Keep Vitest path aliases pointed at workspace source (`packages/*/src/index.ts`) so tests do not depend on stale package `dist` outputs.

## Health & Config Readiness
- Treat `/health` as the release verification surface: return `status`, the build `version`, and the live `environment`. Prefer sourcing `version` from build metadata or an environment override rather than hard-coded `0.0.0` so deployments can be differentiated.
- Rely on `parseRegistryConfig` early and cache it once per worker—fail-fast with `CONFIG_VALIDATION_FAILED` errors when the schema rejects the runtime bindings.
- Cover both happy and failure paths in Vitest (status/headers plus config validation) so downstream tickets can rely on this contract without reintroducing regressions.

## Database Authorization
- Cloudflare D1 (SQLite) does not provide PostgreSQL-style RLS policies.
- Enforce per-actor authorization in handlers and queries (for example `owner_id`/`human_id` filters).
- Fail closed when actor context is missing.

## Rollback and Safety
- For CI deploys, capture pre-deploy artifacts (deployments list, D1 time-travel marker, D1 export).
- If deploy fails after migrations:
  - Roll back Worker to previous version.
  - Restore D1 from time-travel checkpoint.
- When changing routes/domains, validate there is no overlap with existing zone routes.

## Auth & API Keys
- Treat `Authorization: Bearer clw_pat_<token>` as the default registry entry point for human- or CLI-issued requests and assume the value is SHA-256 hashed before persistence (see `api_keys.key_hash`).
- Prefer Drizzle ORM (`src/db/client.ts`) for API-key lookup and `last_used_at` updates; keep raw D1 SQL only for unsupported query shapes.
- Use constant-time comparison when checking the header-derived hash against `api_keys.key_hash`, only allow `status = 'active'`, and surface failures through `AppError` codes such as `API_KEY_MISSING`, `API_KEY_INVALID`, or `API_KEY_REVOKED` so the shared SDK error handler can produce consistent envelopes.
- Enrich the request context with `humanId`, `apiKeyId`, and `apiKeyName` for downstream handlers and update `last_used_at` as part of the auth middleware/handler so analytics and revocation tooling stay honest.
- Keep the middleware reversible: a no-auth `GET /health` can stay open but any future `/v1/*` endpoints should extend this middleware so unauthorized access never reaches the DB layer.

## Public Key Discovery
- `GET /.well-known/claw-keys.json` is the canonical public key discovery endpoint for offline AIT verification.
- Source key material from validated runtime config (`REGISTRY_SIGNING_KEYS` JSON) and return entries with `kid`, `alg`, `crv`, `x`, and `status`.
- Keep cache headers explicit (`max-age=300` + `stale-while-revalidate`) to reduce client fetch load while allowing key rotation to propagate predictably.

## Agent Registration Testing
- POST `/v1/agents` coverage should stay offline/deterministic: reuse or extend the fake `D1Database` helper so Vitest can assert the exact SQL inserted into `agents` without touching a real D1 instance.
- Validate every registration payload against the `packages/protocol` `aitClaimsSchema` expectations (agent DID format, name char set/length, base64url public key, `exp > nbf`, etc.) and expect a structured `AppError` when any field fails so new tests exercise each validation branch.
- Reuse `createApiKeyAuth` tooling to prove `API_KEY_MISSING`, `API_KEY_INVALID`, `API_KEY_REVOKED`, and suspended-human failures before the handler even touches the DB; all auth tests should assert the matching error code/messages that will inform clients about misconfigured PATs.
- Assert that an accepted registration call writes exactly one `agents` row (status `active`, correct `owner_id`, `public_key`, and `current_jti`) and does not leave partial state on failure. Tests should also ensure `gateway_hint`, `expires_at`, and `framework` values propagate when provided so the schema stays in sync.
- When `REGISTRY_SIGNING_KEYS` exposes an active key, the handler must return a signed AIT whose `kid` matches the published key, and clients must be able to verify it via `verifyAIT`/`/.well-known/claw-keys.json`. Add a companion failure test that rejects registration when no valid signing key exists (missing `kid`, revoked status, or malformed `x`).
