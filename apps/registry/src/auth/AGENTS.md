# AGENTS.md (apps/registry/src/auth)

## Purpose
- Keep registry authentication middleware consistent, testable, and fail-closed.

## API Key Auth Rules
- Parse `Authorization` strictly as `Bearer <token>`.
- Reject marker-only PATs (for example, `clw_pat_` without entropy).
- Hash incoming PAT values with SHA-256 before lookup; never persist raw PATs.
- Derive `api_keys.key_prefix` lookup keys from the PAT marker plus token entropy (not the static marker alone), and keep derivation logic in one shared helper.
- Keep PAT token helpers (`parseBearerPat`, prefix derivation, hashing, constant-time compare, token generation) centralized in `api-key-token.ts` so bootstrap and middleware use identical security behavior.
- Use constant-time comparison for hash matching.
- Use Drizzle through `src/db/client.ts` for lookup/update queries so auth code stays schema-driven.
- Only allow `api_keys.status = "active"` and `humans.status = "active"`.
- On success, inject `ctx.human` for downstream handlers, including additive onboarding metadata such as `onboardingSource` and `agentLimit`.
- Return auth failures through `AppError` with 401 status and stable codes.

## Verification
- Cover valid, invalid, and missing PAT paths in `server.test.ts`.
- Verify middleware updates `api_keys.last_used_at` on successful auth.

## Agent Auth Refresh Rules
- Keep agent refresh token helpers (`clw_rft_`, `clw_agt_`, prefix derivation, hashing, token generation) centralized in `agent-auth-token.ts`.
- Verify agent-authenticated refresh requests using `Authorization: Claw <AIT>` and PoP headers; never trust refresh payload without AIT + PoP verification.
- Enforce issuer + keyset-based AIT verification against active registry signing keys only.
- Validate `X-Claw-Timestamp` skew and fail closed on malformed/expired signatures.
- Never log or persist plaintext refresh/access tokens server-side; persist only hash/prefix material.

## Agent Access Validation Rules
- Keep access-token parsing (`clw_agt_`) centralized in `agent-auth-token.ts`; do not duplicate marker/format checks in route handlers.
- `POST /v1/agents/auth/validate` must fail closed with `401` for missing/invalid/expired/revoked credentials.
- Access validation must compare hashed token material with constant-time semantics and update `access_last_used_at` on successful validation.

## Internal Service Auth Rules
- Keep proxy-to-registry internal auth in `service-auth.ts` with database-backed service records (`internal_services`).
- Keep scope normalization/parsing centralized in `internal-service-scopes.ts` so admin route payload validation and middleware config parsing cannot drift.
- Guard all internal routes (`/internal/v1/...`) with `createServiceAuth({ requiredScopes })` and the `INTERNAL_SERVICE_ID_HEADER`/`INTERNAL_SERVICE_SECRET_HEADER` names defined in `@clawdentity/sdk`.
- Persist per-service secrets with the `clw_srv_` marker, hash them before storing, and refresh `last_used_at` on every authenticated call.
- Fail closed when a service record is missing, disabled, or presents an invalid prefix/secret, and surface `INTERNAL_SERVICE_UNAUTHORIZED`/`INTERNAL_SERVICE_FORBIDDEN` codes accordingly.
