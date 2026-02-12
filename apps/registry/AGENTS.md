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
- Keep environment variables non-secret in `wrangler.jsonc` and secret values out of git.

## Validation
- Validate config changes with `wrangler check` before deployment.
- Run `pnpm -F @clawdentity/registry run test` and `pnpm -F @clawdentity/registry run typecheck` for app-level safety.
- Keep Vitest path aliases pointed at workspace source (`packages/*/src/index.ts`) so tests do not depend on stale package `dist` outputs.

## Database Authorization
- Cloudflare D1 (SQLite) does not provide PostgreSQL-style RLS policies.
- Enforce per-actor authorization in handlers and queries (for example `owner_id`/`human_id` filters).
- Fail closed when actor context is missing.

## T10 Schema Contract
- Source of truth for registry schema is `src/db/schema.ts`.
- Baseline migration for T10 verification is `drizzle/0000_common_marrow.sql`.
- T10 required tables: `humans`, `agents`, `revocations`, `api_keys`.
- T10 required indexes:
  - `idx_agents_owner_status` on `agents(owner_id, status)`
  - revocations `jti` lookup index (`revocations_jti_unique` satisfies this as a unique index)
- Keep schema, migration SQL, and `src/db/schema.contract.test.ts` synchronized in the same change.
- Migration verification command path:
  - local apply: `pnpm -F @clawdentity/registry run db:migrate:local`
  - fresh local smoke (non-destructive): `pnpm -F @clawdentity/registry exec wrangler d1 migrations apply clawdentity-db-dev --local --env dev --persist-to .wrangler/t10-fresh-smoke`

## Rollback and Safety
- For CI deploys, capture pre-deploy artifacts (deployments list, D1 time-travel marker, D1 export).
- If deploy fails after migrations:
  - Roll back Worker to previous version.
  - Restore D1 from time-travel checkpoint.
- When changing routes/domains, validate there is no overlap with existing zone routes.
