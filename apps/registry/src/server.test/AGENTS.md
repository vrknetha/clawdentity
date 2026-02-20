# AGENTS.md - `apps/registry/src/server.test`

## Purpose
- Keep registry server tests modular, deterministic, and easy to maintain.
- Preserve behavior while allowing focused edits by route/concern.

## Organization Rules
- Keep each `*.test.ts` file focused on one route or tightly related route concern.
- Keep each `*.test.ts` file under 800 lines.
- Keep `helpers.ts` as a thin public export shim used by tests.
- Place shared helper implementation in `helpers/**` with focused modules (`claims`, `crypto`, `pat`, `db/*`); do not duplicate harness logic across test files.
- Prefer adding small helper functions in the appropriate `helpers/**` module when setup repeats 3+ times.
- Keep every file under `server.test` (including `helpers/**`) below 800 lines.

## Change Rules
- Preserve existing assertions and response contracts when refactoring test structure.
- When adding tests, keep test names explicit about endpoint, auth mode, and expected status.
- Favor deterministic fixtures (fixed IDs/timestamps/nonces) over random values.
- Avoid coupling tests to execution order; each test must be independently runnable.

## Route Coverage
- Maintain separate coverage for:
  - health/metadata/admin bootstrap
  - key publication + CRL
  - resolve + me
  - invites
  - me API keys
  - agents listing/ownership/internal auth
  - agent lifecycle (delete/reissue)
  - registration challenge/create
  - agent auth refresh/validate/revoke

## Validation
- For server test changes, run:
  - `pnpm -C apps/registry typecheck`
  - `pnpm -C apps/registry test -- server`
