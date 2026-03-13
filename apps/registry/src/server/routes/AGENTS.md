# AGENTS.md (apps/registry/src/server/routes)

## Purpose
- Keep registry route modules small and externally stable.

## Rules
- Route modules register handlers only; shared config parsing, database helpers, and event-bus behavior belong in `../helpers` or higher-level server composition.
- `/health` must preserve the existing top-level fields while allowing additive readiness metadata for deployment verification.
- New route-level readiness or metadata fields must be additive and must not break existing clients that only read `status`, `version`, or `environment`.
- Keep GitHub onboarding starter-pass logic in dedicated onboarding routes; do not overload invite routes with public hosted onboarding behavior.
- Public hosted onboarding must stay additive: admin invites remain available for operator/self-hosted flows even when landing/docs prefer GitHub starter passes.
- Enforce human-level agent quotas server-side in agent registration routes before challenge finalization; UI copy is not a substitute for quota enforcement.
- Enforce starter-pass agent quotas inside the guarded registration mutation itself so parallel `/v1/agents` requests cannot bypass the cap between challenge verification and insert.
