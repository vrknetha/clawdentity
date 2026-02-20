# AGENTS.md - `apps/registry/src/server.test/helpers`

## Purpose
- Keep server-test helpers deterministic, modular, and easy to evolve without changing test behavior.

## Structure Rules
- Keep `../helpers.ts` as a stable export-only shim for tests.
- Group helper implementations by concern:
  - `claims.ts`, `crypto.ts`, `pat.ts` for top-level helper APIs.
  - `db/types.ts`, `db/parse.ts`, `db/resolvers.ts`, `db/mock.ts`, `db/run-handlers*.ts` for fake D1 behavior.
- Keep each helper file under 800 lines; split further when a file approaches the limit.

## Behavior Rules
- Preserve SQL parsing/matching semantics in fake DB helpers unless a test explicitly requires a change.
- Reuse shared parser/resolver/run-handler utilities; avoid duplicated query handling logic.
- Keep fixtures deterministic (fixed timestamps/IDs/nonces) and avoid randomization.

## Validation
- For helper changes, run:
  - `pnpm -C apps/registry typecheck`
  - `pnpm -C apps/registry test -- server`
