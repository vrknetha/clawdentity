# AGENTS.md (apps/registry/src/db)

## Purpose
- Keep the registry database contract explicit and testable for T10 and follow-up tickets.

## Source of Truth
- Define schema in `schema.ts`.
- Keep generated SQL migrations in `../../drizzle/`.
- Treat `schema.contract.test.ts` as the executable contract for required table/index coverage.

## T10 Baseline Requirements
- Required tables: `humans`, `agents`, `revocations`, `api_keys`.
- Required index: `idx_agents_owner_status` on `agents(owner_id, status)`.
- Required revocations `jti` lookup index may be unique or non-unique; current baseline is `revocations_jti_unique`.

## Change Rules
- When changing table/index names, update all of:
  - `schema.ts`
  - affected SQL migration files under `../../drizzle/`
  - `schema.contract.test.ts`
- Avoid duplicate index definitions across schema and migration outputs.

## Verification
- Migration apply: `pnpm -F @clawdentity/registry run db:migrate:local`
- Fresh migration smoke: `pnpm -F @clawdentity/registry exec wrangler d1 migrations apply clawdentity-db-dev --local --env dev --persist-to .wrangler/t10-fresh-smoke`
