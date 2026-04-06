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
- Group join tokens use one active reusable-token model per group:
  - `POST /v1/groups/:id/join-tokens` returns the current active token (creating one if missing)
  - `POST /v1/groups/:id/join-tokens/reset` rotates to a new active token
  - `DELETE /v1/groups/:id/join-tokens/current` revokes without replacement
  - keep request validation hash-based, but persist encrypted recoverable token material so "show current token" works after issuance
  - `POST /v1/groups/:id/join-tokens` must normalize pre-existing multi-active state by revoking all other unrevoked rows and keeping at most one active token row
  - `POST /v1/groups/:id/join-tokens/reset` must create the replacement token before revoking old active rows, and transaction/fallback logic must prevent a failed replacement insert from leaving the group with zero active tokens
  - join-token current/reset routes depend on migration `0007_group_join_tokens_active_current.sql`; if `token_ciphertext` is missing, return a controlled `CONFIG_VALIDATION_FAILED` error (never opaque SQL/internal failure)
- Group member-cap enforcement must run inside the same join mutation unit as the member insert (transaction path or guarded insert), not as a pre-check outside the write path.
- Route handlers that expect JSON request bodies must treat malformed JSON as client input errors (4xx) and must not silently coerce parse failures into default payloads that trigger mutations.
- When a route supports both PAT and non-PAT auth (for example PAT-or-agent flows), reuse the shared auth resolver from `src/auth/` instead of re-implementing PAT hash/lookup logic in route modules.
- `GET /v1/agents/profile` is the canonical authenticated profile lookup by DID and must return only contract fields: `agentDid`, `agentName`, `displayName`, `framework`, `status`, `humanDid`.
- `GET /v1/agents/profile` is currently an authenticated directory-style lookup, not a per-resource-scoped ownership check. Do not silently narrow it without replacing the peer refresh and `pair.accepted` enrichment flows that rely on cross-DID reads.
- `GET /v1/groups/:id` must remain lightweight and return only `group.id` + `group.name`; keep membership/authorization checks in route-layer helpers and avoid embedding rendering logic.
- `GET /v1/groups/:id` PAT access must be authorized against that specific group (owner or active-member ownership), not just token validity.
- For `GET /v1/groups/:id`, resolve group existence before access checks across both PAT and agent-auth branches so missing groups return `GROUP_NOT_FOUND` (404) and permission failures return `GROUP_READ_FORBIDDEN` (403).
- Group management contract rules are mandatory for operator CLI compatibility:
  - `POST /v1/groups` is agent-auth only; PAT/human auth is unauthorized for this route.
  - `POST /v1/groups` must write both rows in the create path: `groups` + creator `group_members` row with `role=admin`.
  - Group-create auth must run before payload parsing so unauthenticated requests fail as auth errors, not payload-shape errors.
  - `POST /v1/groups/:id/join-tokens` remains manageable by allowed actors, but join-token issuance is member-only:
    - reject payloads that include `role`, `maxUses`, or `expiresInSeconds`
    - persist tokens as reusable active-member tokens (no expiry/usage-cap semantics)
  - For agent-auth manage actions, allow only creator-owner agents.
  - For agent-auth reads, allow creator-owner agents or active group members.
- Successful `POST /v1/groups/join` membership inserts should trigger best-effort member-wide notification fan-out (all active group members, including the joiner) through helper-level event-bus publishing; do not inline queue payload construction in route handlers.
