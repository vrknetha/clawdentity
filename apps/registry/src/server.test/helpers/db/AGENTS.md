# AGENTS.md (apps/registry/src/server.test/helpers/db)

## Purpose
- Keep fake D1 helpers deterministic and easy to extend for server tests.

## Rules
- Keep SQL-shape parsing (`parse.ts`) pure and reusable.
- Keep query branch orchestration in `mock.ts`; move entity-specific row projection/filter logic into resolver modules.
- Keep each resolver file scoped to one table/domain (`agents`, `api-keys`, `humans`, `invites`, `crl`, auth sessions, registration challenges).
- Preserve backward-compatible exports from `resolvers.ts` as the public resolver entrypoint for test harness imports.
- When adding a new fake table, add a dedicated resolver module and re-export it from `resolvers/index.ts`.
- Keep rollback-sensitive tables (`api_keys`, `internal_services`) modeled in run handlers so fallback compensation tests can assert row cleanup deterministically.
- Avoid embedding clock/random side effects in resolver functions.
- Keep `all()` and `raw()` result shapes in sync for joined auth queries and new tables, otherwise Drizzle-backed tests can silently miss fields that production routes depend on.
- Keep targeted fault-injection knobs (for example invalid mutation result shapes) explicit and query-scoped so route-level failure tests stay deterministic.
