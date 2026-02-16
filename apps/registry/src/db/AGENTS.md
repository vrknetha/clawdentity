# AGENTS.md (apps/registry/src/db)

## Purpose
- Keep registry database access and schema contracts explicit, consistent, and testable.

## Source Of Truth
- Define tables and indexes in `schema.ts`.
- Keep generated migration SQL in `apps/registry/drizzle/` synchronized with schema changes.
- Treat contract tests (for example `schema.contract.test.ts`) as executable checks for required table/index coverage.

## Baseline Requirements
- Required tables: `humans`, `agents`, `revocations`, `api_keys`, `agent_auth_sessions`, `agent_auth_events`.
- Required index: `idx_agents_owner_status` on `agents(owner_id, status)`.
- Revocation `jti` lookup can be unique or non-unique; current baseline uses `revocations_jti_unique`.
- Agent auth refresh lookups require prefix indexes on `agent_auth_sessions.refresh_key_prefix` and `agent_auth_sessions.access_key_prefix`.
- One session per agent is enforced by `agent_auth_sessions_agent_id_unique`.

## Query Rules
- Prefer Drizzle (`createDb`) for application reads/writes.
- Keep raw SQL only for cases Drizzle cannot express cleanly; document the reason inline.
- For auth/security paths, keep constant-time comparisons in application code when matching secrets/hashes.

## Change Rules
- When changing table/index names, update all relevant artifacts together:
- `schema.ts`
- affected SQL migration files under `apps/registry/drizzle/`
- related schema/contract tests
- Avoid duplicate index definitions across schema and migration outputs.

## Verification
- Run `pnpm -F @clawdentity/registry run db:migrate:local` for migration smoke checks.
- Run `pnpm -F @clawdentity/registry run test` and `pnpm -F @clawdentity/registry run typecheck` after DB-layer changes.
- Optional fresh migration smoke:
- `pnpm -F @clawdentity/registry exec wrangler d1 migrations apply clawdentity-db-dev --local --env dev --persist-to .wrangler/t10-fresh-smoke`
