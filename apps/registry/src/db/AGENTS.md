# AGENTS.md (apps/registry/src/db)

## Purpose
- Keep registry database access consistent for Cloudflare D1 and Drizzle ORM.

## Source Of Truth
- Define tables and indexes only in `schema.ts`.
- Keep migration SQL in `apps/registry/drizzle/` synchronized with schema changes.
- Add/adjust tests whenever schema contracts or indexes change.

## Query Rules
- Prefer Drizzle (`createDb`) for application reads/writes.
- Keep raw SQL only for cases Drizzle cannot express cleanly; document why inline.
- For auth/security paths, keep constant-time comparisons in application code when matching secrets/hashes.

## Verification
- Run `pnpm -F @clawdentity/registry run db:migrate:local` for migration smoke checks.
- Run `pnpm -F @clawdentity/registry run test` and `pnpm -F @clawdentity/registry run typecheck` after DB-layer changes.
