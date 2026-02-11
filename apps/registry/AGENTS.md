# AGENTS.md (apps/registry)

## Purpose
- Define registry app conventions for Cloudflare Worker runtime and Wrangler configuration.

## Wrangler Configuration
- Use `wrangler.jsonc` as the source of truth for worker config.
- Keep `dev` and `production` environments explicit and isolated in config.
- Keep D1 database IDs version-controlled; manage secrets with `wrangler secret put`.
- Keep `migrations_dir` aligned with Drizzle output directory (`drizzle`).

## Runtime and API
- Preserve `/health` response contract: `{ status, version, environment }`.
- Keep environment variables non-secret in `wrangler.jsonc` and secret values out of git.

## Validation
- Validate config changes with `wrangler check` before deployment.
- Run `pnpm -F @clawdentity/registry run test` and `pnpm -F @clawdentity/registry run typecheck` for app-level safety.
