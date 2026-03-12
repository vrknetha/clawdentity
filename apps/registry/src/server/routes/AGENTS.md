# AGENTS.md (apps/registry/src/server/routes)

## Purpose
- Keep registry route modules small and externally stable.

## Rules
- Route modules register handlers only; shared config parsing, database helpers, and event-bus behavior belong in `../helpers` or higher-level server composition.
- `/health` must preserve the existing top-level fields while allowing additive readiness metadata for deployment verification.
- New route-level readiness or metadata fields must be additive and must not break existing clients that only read `status`, `version`, or `environment`.
