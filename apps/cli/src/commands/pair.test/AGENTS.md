# AGENTS.md (pair command tests)

## Purpose
- Keep `pair` command tests modular and deterministic while preserving existing behavior.
- Prevent oversized test files and duplicate mock/setup logic.

## File Boundaries
- `helpers.ts`: shared fixtures, env reset hooks, typed dependency casts, and CLI command runner.
- `start.test.ts`: `startPairing` behavior and proxy selection cases.
- `confirm.test.ts`: `confirmPairing` behavior, QR decode flow, and relay-peer sync.
- `status.test.ts`: `getPairingStatus` normalization, pending checks, and wait/poll persistence.
- `output.test.ts`: CLI output assertions for `pair start|confirm|status`.

## Test Splitting Practices
- Keep each test file under 800 LOC.
- Centralize reusable fixture/build helpers in `helpers.ts`; do not copy-paste setup blocks.
- Keep tests hermetic: mock filesystem/network dependencies, avoid host state dependence.
- Preserve exact stdout/stderr and `process.exitCode` assertions for CLI behavior contracts.

## Validation
- Run before handoff:
  - `pnpm -C apps/cli typecheck`
  - `pnpm -C apps/cli test -- pair`
