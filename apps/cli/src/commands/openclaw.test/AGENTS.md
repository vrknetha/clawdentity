# AGENTS.md (openclaw command tests)

## Purpose
- Keep `openclaw` tests modular, deterministic, and behavior-preserving.
- Avoid oversized test files and duplicated sandbox/env setup code.

## File Boundaries
- `helpers.ts`: shared sandbox builders, state seeders, env restore helper, and common config/fetch fixtures.
- `invite.test.ts`: invite-code encode/decode behavior.
- `setup-core.test.ts`: core setup patching, idempotency, checklist recovery, and hook-session normalization.
- `setup-runtime.test.ts`: setup behavior tied to env/path resolution, connector allocation, and runtime config persistence.
- `doctor.test.ts`: diagnostic checks and CLI `doctor` command filtering behavior.
- `relay.test.ts`: relay probe and websocket diagnostic behavior.

## Splitting Practices
- Keep each test file under 800 LOC.
- Move reusable sandbox/env helpers into `helpers.ts`; avoid repeated inline fixtures.
- Keep tests hermetic: no real network/process dependencies, no host state assumptions.
- Preserve existing assertions for stdout/stderr semantics, status codes, and `process.exitCode` behavior.

## Validation
- Run before handoff:
  - `pnpm -C apps/cli typecheck`
  - `pnpm -C apps/cli test -- openclaw`
