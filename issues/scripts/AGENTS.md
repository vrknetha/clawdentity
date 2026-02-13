# AGENTS.md (issues/scripts)

## Purpose
- Keep issue-governance scripts deterministic and local-only.
- Ensure dependency/order checks remain stable as backlog metadata evolves.

## Script Rules
- Scripts in this folder must run without network access.
- Prefer read-only checks that fail with actionable messages.
- Treat `issues/T00.md` through `issues/T38.md` as canonical ticket inputs.

## Validation Expectations
- `validate-ticket-set.mjs` must verify schema order, dependency integrity, deployment gate (`T38`) requirements, sequential order, and parallel-wave safety.
- Exit with non-zero status on any violation and print each violation on its own line.

## Maintenance
- When `issues/EXECUTION_PLAN.md` wave/order format changes, update parser logic in the same commit.
- Keep checks strict enough to block drift, but avoid coupling to cosmetic markdown formatting.
