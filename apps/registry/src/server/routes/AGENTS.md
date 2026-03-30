# AGENTS.md (apps/registry/src/server/routes)

## Purpose
- Keep registry route modules small and externally stable.

## Rules
- Route modules register handlers only; shared config parsing, database helpers, and event-bus behavior belong in `../helpers` or higher-level server composition.
- `/health` must preserve the existing top-level fields while allowing additive readiness metadata for deployment verification.
- New route-level readiness or metadata fields must be additive and must not break existing clients that only read `status`, `version`, or `environment`.
- Caller-facing onboarding routes must publish reachable URLs. `/v1/metadata`, invite redeem, and starter-pass onboarding must not leak loopback-only registry/proxy addresses when the request came through Docker or another external host.
- When a registry request rewrites a loopback proxy URL to a caller-facing host, keep the proxy's configured port instead of copying the registry request port.
- Keep GitHub onboarding starter-pass logic in dedicated onboarding routes; do not overload invite routes with public hosted onboarding behavior.
- Public hosted onboarding must stay additive: admin invites remain available for operator/self-hosted flows even when landing/docs prefer GitHub starter passes.
- For repeat GitHub login, reissue an expired starter pass for the same provider subject instead of returning an "already issued" dead-end.
- GitHub OAuth state cookies must set `Secure` only on HTTPS requests so local/plain-HTTP deployments can complete callback state validation.
- Enforce human-level agent quotas server-side in agent registration routes before challenge finalization; UI copy is not a substitute for quota enforcement.
- Enforce starter-pass agent quotas inside the guarded registration mutation itself so parallel `/v1/agents` requests cannot bypass the cap between challenge verification and insert.
- Reissued AITs must stay aligned with the stored agent/human DID authority; do not switch issuer authority just because the current request arrived through a different hostname alias.
- Agent auth revoke events that proxy consumes must use shared protocol constants/helpers for event name/reason/metadata shape (`agent.auth.revoked`, `agent_revoked`, `metadata.agentDid`) rather than ad-hoc inline literals.
- Any mutation guarded by row-count checks must call `getMutationRowCount` with an explicit operation identifier and rely on strict D1 `meta.changes` handling; do not add route-local fallback parsing for legacy mutation shapes.
- Route modules must reference shared mutation-operation constants rather than inline operation strings when calling mutation row-count helpers.
