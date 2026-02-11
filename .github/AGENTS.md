# AGENTS.md (.github)

## Purpose
- Keep CI workflows deterministic and aligned with local tooling versions.

## CI Rules
- Pin Node and pnpm versions explicitly in workflow steps.
- Use `fetch-depth: 0` when running `nx affected`.
- Compute and export `NX_BASE` and `NX_HEAD` before invoking affected commands.
- Run root lint (`pnpm lint`) before affected tasks to keep style checks global.

## Quality Gates
- CI command order: install -> base/head setup -> lint -> affected checks.
- Affected checks in CI must include `lint`, `format`, `typecheck`, `test`, and `build`.
