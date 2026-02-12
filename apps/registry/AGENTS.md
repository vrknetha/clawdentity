# Registry Agent Notes

## Purpose
- Keep registry deployment and domain configuration consistent across environments.

## Domain Rules
- Public endpoints must use branded custom domains, not `*.workers.dev`.
- Development custom domain: `dev.api.clawdentity.com`.
- Production custom domain: `api.clawdentity.com`.
- `workers.dev` is currently disabled by custom-domain routing unless `workers_dev = true` is explicitly set.

## Deployment Rules
- Always deploy with explicit environment: `--env dev` or `--env production`.
- For deploy scripts, run D1 migrations before Worker deploy.
- Verify `GET /health` returns:
  - `status: "ok"`
  - expected environment value (`development` or `production`).
- For CI deploys, capture a pre-migration D1 export and time-travel point-in-time marker for rollback.
- Local development should run migrations against the local D1 alias before `wrangler dev --env dev`, e.g. `pnpm -F @clawdentity/registry dev:local`.

## Database Authorization Rules
- Cloudflare D1 (SQLite) does not provide PostgreSQL-style row-level security (RLS) policies.
- Enforce per-actor access in application queries and handlers (e.g., `owner_id` / `human_id` filters).
- Treat authorization as fail-closed: no actor context means no data access.

## Change Safety
- When changing routes/domains, validate no overlap with existing zone routes.
- Do not store secrets in repo; use `wrangler secret put`.
- If deploy fails after migrations, rollback DB with D1 Time Travel and rollback Worker to the previous version.
