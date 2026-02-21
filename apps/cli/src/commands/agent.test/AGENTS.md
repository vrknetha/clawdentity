# AGENTS.md (agent command tests)

## Purpose
- Keep `agent` command tests modular, deterministic, and easy to extend.
- Preserve behavior parity with command output and error handling contracts.

## File Boundaries
- `helpers.ts`: shared mocks, fixtures, command runner, and reusable setup helpers.
- `create.test.ts`: `agent create` success/failure and file-permission cases.
- `auth-refresh.test.ts`: `agent auth refresh` file loading, refresh calls, and atomic-write checks.
- `revoke.test.ts`: `agent revoke` local identity parsing and registry error handling.
- `inspect.test.ts`: `agent inspect` AIT parsing and validation/output coverage.

## Test Guardrails
- Keep each test file under 800 LOC.
- Reuse `helpers.ts` for mock setup and path/fixture constants; do not duplicate bootstrap scaffolding.
- Keep tests hermetic: no real filesystem/network calls, no dependence on host env state.
- Preserve stable stdout/stderr assertions and `process.exitCode` assertions for CLI behavior.
- Reset global stubs in `afterEach` whenever `fetch` or other globals are stubbed.

## Validation
- Run before handoff:
  - `pnpm -C apps/cli typecheck`
  - `pnpm -C apps/cli test -- agent`
