# AGENTS.md (apps/registry/src)

## Purpose
- Keep runtime entrypoints and route contracts consistent for the registry worker.

## Entrypoints
- `server.ts` is the Cloudflare Worker runtime entrypoint.
- `index.ts` should re-export `server.ts` for package build/test compatibility.

## Health Contract
- `/health` must return HTTP 200 with `{ status, version, environment }` on valid config.
- Invalid runtime config must fail through the shared error handler and return `CONFIG_VALIDATION_FAILED`.
- Runtime startup config must fail fast for non-test environments when required keys are missing (`PROXY_URL`, `REGISTRY_ISSUER_URL`, `EVENT_BUS_BACKEND`, `BOOTSTRAP_SECRET`, `REGISTRY_SIGNING_KEY`, `REGISTRY_SIGNING_KEYS`).

## Admin Bootstrap Contract
- `POST /v1/admin/bootstrap` is a one-time bootstrap endpoint gated by `BOOTSTRAP_SECRET`.
- Use `ADMIN_BOOTSTRAP_PATH` from `@clawdentity/protocol` for route registration and test requests; do not hardcode bootstrap path literals in registry code.
- Require `x-bootstrap-secret` header and compare with constant-time semantics; invalid/missing secret must return `401 ADMIN_BOOTSTRAP_UNAUTHORIZED`.
- If `BOOTSTRAP_SECRET` is not configured, return `503 ADMIN_BOOTSTRAP_DISABLED`.
- If any admin human already exists, return `409 ADMIN_BOOTSTRAP_ALREADY_COMPLETED`.
- Success response must include `{ human, apiKey }` and return the PAT token only in bootstrap response.
- Persist admin bootstrap atomically where supported (transaction). When falling back because transactions are unavailable, run the manual mutation with rollback-on-api-key-failure so that no admin human exists without the new API key even if part of the bootstrap fails.
- Fallback path must be compensation-safe: if API key insert fails after admin insert, delete the inserted admin row before returning failure so retry remains possible.

## Registry Keyset Contract
- `/.well-known/claw-keys.json` is a public endpoint and must remain unauthenticated.
- Return `keys[]` entries with `kid`, `alg`, `crv`, `x`, and `status` so SDK/offline verifiers can consume directly.
- Keep cache headers explicit and short-lived (`max-age=300` + `stale-while-revalidate`) to balance key rotation with client efficiency.

## CRL Snapshot Contract
- `GET /v1/crl` is a public endpoint and must remain unauthenticated so SDK/proxy clients can refresh revocation state without PAT bootstrap dependencies.
- Apply per-client-IP throttling on `GET /v1/crl` and return `429 RATE_LIMIT_EXCEEDED` when over budget.
- Success response shape must remain `{ crl: <jwt> }` where `crl` is an EdDSA-signed token with `typ=CRL`.
- Build CRL claims from the full `revocations` table (MVP full snapshot), joining each row to `agents.did` for `revocations[].agentDid`.
- Keep CRL cache headers explicit and short-lived (`max-age=300` + `stale-while-revalidate`) for predictable revocation propagation.
- Ensure CRL JWT `exp` exceeds the full cache serve window (`max-age + stale-while-revalidate`) with a small safety buffer so strict verifiers never see cache-valid but token-expired snapshots.
- If no revocations exist yet, return `404 CRL_NOT_FOUND` instead of emitting an unsigned or schema-invalid empty snapshot.
- Route tests should verify the returned CRL token using SDK `verifyCRL` and the published active keys from `/.well-known/claw-keys.json`.

## GET /v1/resolve/:id Contract
- Public endpoint: no PAT/auth required.
- Validate `:id` as ULID via dedicated parser and return `400 AGENT_RESOLVE_INVALID_PATH` on invalid path input.
- Rate-limit by client IP with a basic in-memory limiter and return `429 RATE_LIMIT_EXCEEDED` when over threshold.
- Return only public fields: `{ did, name, framework, status, ownerDid }`.
- Do not expose PII or internal fields (email, API key metadata, or private key material).
- For unknown IDs, return `404 AGENT_NOT_FOUND` with no ownership-leak variants.
- Keep framework output stable as a non-empty string for legacy rows missing `framework`.

## Proxy Pairing Key Contracts
- `POST /v1/proxy-pairing-keys` requires PAT auth (`createApiKeyAuth`) and stores issuer-scoped pairing signing keys for proxy ticket verification.
- Validate payload strictly: `issuerOrigin` must be URL origin (`http`/`https`), `pkid` non-empty, `publicKeyX` non-empty, `expiresAt` valid future ISO timestamp.
- Keep writes idempotent on (`issuer_origin`, `pkid`) and update key material/expiry when repeated registration arrives.
- `GET /v1/proxy-pairing-keys/resolve` is public and returns only active (non-expired) key metadata needed for proxy ticket verification.
- `POST /internal/v1/proxy-pairing-keys` requires service auth and must resolve `ownerDid -> humans.id` before persisting `created_by`.
- `GET /internal/v1/proxy-pairing-keys/resolve` requires service auth and mirrors the same active-key lookup contract.
- For unknown/expired keys, return `404 PROXY_PAIRING_KEY_NOT_FOUND`; do not leak extra owner data.

## Validation
- Run `pnpm -F @clawdentity/registry run test` after changing routes or config loading.
- Run `pnpm -F @clawdentity/registry run typecheck` before commit.
- For route-limit tests, prefer `createRegistryApp({ rateLimit: ... })` overrides to keep tests deterministic without weakening production defaults.
- When using fake D1 adapters in route tests, make select responses honor bound parameters, selected-column projection, and join semantics so query-shape regressions are caught.
- Fake D1 join emulation should drop rows when `innerJoin` targets are missing so tests catch missing/incorrect joins instead of masking them with stubbed values.

## GET /v1/agents Contract
- Require PAT auth via `createApiKeyAuth`; only caller-owned agents may be returned.
- Keep query parsing in `agent-list.ts` to avoid duplicating validation rules in route handlers.
- Supported optional filters:
  - `status`: `active | revoked`
  - `framework`: trimmed non-empty string, max 32 chars, no control chars
  - `limit`: integer `1..100`, default `20`
  - `cursor`: ULID (opaque page token)
- Return minimal agent fields only: `{ id, did, name, status, expires }` plus pagination `{ limit, nextCursor }`.
- Keep ordering deterministic (`id` descending) and compute `nextCursor` from the last item in the returned page.
- Keep error detail exposure environment-aware via `shouldExposeVerboseErrors`: generic 400 message in `production`, detailed `fieldErrors` in `development`/`test`.

## GET /v1/agents/:id/ownership Contract
- Require PAT auth via `createApiKeyAuth`.
- Validate `:id` as ULID and return `400 AGENT_OWNERSHIP_INVALID_PATH` for malformed IDs.
- Return `{ ownsAgent: true }` when the caller owns the agent and `{ ownsAgent: false }` for foreign or missing IDs.
- Keep this endpoint ownership-only; do not return agent metadata.

## POST /internal/v1/ownership/check Contract
- Require service auth via internal service token middleware.
- Validate `ownerDid` and `agentDid` as DID strings (`human` and `agent` kinds respectively).
- Return `{ ownsAgent, agentStatus }` where `agentStatus` is `active | revoked | null`.
- Keep this endpoint internal-only for proxy service-to-service ownership checks.

## POST /v1/invites Contract
- Require PAT auth via `createApiKeyAuth`.
- Enforce admin-only access with explicit `403 INVITE_CREATE_FORBIDDEN` for authenticated non-admin callers.
- Validate payload in a dedicated helper module (`invite-lifecycle.ts`) and keep malformed-json handling environment-aware (`INVITE_CREATE_INVALID`).
- Generate invite codes server-side only; never accept client-supplied codes for create.
- Persist one invite row per request in `invites` with `redeemed_by = null` and optional `expires_at`.

## POST /v1/invites/redeem Contract
- Public endpoint: no PAT required.
- Validate payload in `invite-lifecycle.ts` with explicit error code `INVITE_REDEEM_INVALID`.
- One-time semantics are enforced by guarded update (`redeemed_by IS NULL`); repeated redeem attempts must return explicit invite lifecycle errors.
- Expired invites must be rejected with `INVITE_REDEEM_EXPIRED` before token issuance.
- Successful redeem must create a new active user human and mint a PAT in the same mutation unit as invite consumption.
- Successful redeem response must include `proxyUrl` sourced from registry config (`PROXY_URL`) so onboarding clients can persist relay routing without prompting for proxy details.
- Keep mutation flow transaction-first; on local fallback (no transaction support), apply compensation rollback so failed redeem attempts do not leave partially-created humans or consumed invites.

## POST /v1/me/api-keys Contract
- Require PAT auth via `createApiKeyAuth`; unauthenticated calls must fail before payload parsing.
- Accept optional `{ name }`; default to `api-key` when omitted.
- Validate `name` as trimmed, non-empty when provided, max 64 chars, and free of control characters.
- Return plaintext token only in create response; never persist plaintext token in DB.
- Persist only hashed lookup materials (`key_hash`, `key_prefix`) with `status=active` and `last_used_at=null`.

## GET /v1/me/api-keys Contract
- Require PAT auth via `createApiKeyAuth`.
- Return caller-owned key metadata for both active and revoked keys.
- Response must include only `{ id, name, status, createdAt, lastUsedAt }`.
- Never expose `key_hash`, `key_prefix`, or plaintext token in list responses.

## DELETE /v1/me/api-keys/:id Contract
- Require PAT auth via `createApiKeyAuth`.
- Validate `:id` as ULID and return `400 API_KEY_REVOKE_INVALID_PATH` for invalid path input.
- Enforce owner scoping: unknown or foreign key IDs must return `404 API_KEY_NOT_FOUND`.
- Revoke by setting `status=revoked`; return `204` for successful revoke and already-revoked owned keys.
- Revoked PATs must fail subsequent auth with `401 API_KEY_REVOKED`, while unrelated active PATs continue to authenticate.

## POST /v1/agents/challenge Contract
- Require PAT auth via `createApiKeyAuth`; unauthenticated calls must fail before payload parsing.
- Accept only `{ publicKey }` and validate it as base64url Ed25519 (32-byte decode).
- Persist challenge state in D1 (`agent_registration_challenges`) with owner binding, nonce, expiry, and status.
- Return challenge metadata needed for deterministic proof signing: `challengeId`, `nonce`, `ownerDid`, `expiresAt`, algorithm marker, and canonical message template.
- Keep challenge TTL short-lived (5 minutes) and make replay protection stateful (pending -> used).

## POST /v1/agents Contract
- Require PAT auth via `createApiKeyAuth`; unauthenticated calls must fail before payload parsing.
- Validate request payload fields with explicit rules:
  - `name`: protocol-compatible agent name validation.
  - `framework`: optional; default to `openclaw` when omitted.
  - `publicKey`: base64url Ed25519 key that decodes to 32 bytes.
  - `ttlDays`: optional; default `30`; allow only integer range `1..90`.
- Require ownership-proof fields:
  - `challengeId`: ULID from `/v1/agents/challenge`.
  - `challengeSignature`: base64url Ed25519 signature over the canonical proof message.
- Keep request parsing and validation in a reusable helper module (`agent-registration.ts`) so future routes can share the same constraints without duplicating schema logic.
- Keep `agent-registration.ts` as the stable facade import path and keep implementation split under `agent-registration/` by concern:
  - `constants.ts` for defaults/limits/issuer resolution
  - `parsing.ts` for payload validation
  - `challenge.ts` for challenge construction
  - `proof.ts` for ownership-proof verification
  - `creation.ts` for registration/reissue claim builders
- Keep error detail exposure environment-aware via `shouldExposeVerboseErrors` (shared SDK helper path): return generic messages without internals in `production`, but include validation/config details in `development`/`test` for debugging.
- Persist `agents.current_jti` and `agents.expires_at` on insert; generated AIT claims (`jti`, `exp`) must stay in sync with those persisted values.
- Verify challenge ownership before signing AIT: challenge must exist for the caller, be unexpired, remain `pending`, and match the request public key + signature.
- Consume challenge with guarded state transition (`pending` -> `used`) in the same mutation unit as agent insert; reject zero-row updates as replayed challenge.
- Use shared SDK datetime helpers (`nowUtcMs`, `toIso`, `nowIso`, `addSeconds`) for issuance/expiry math and timestamp serialization in route logic.
- Resolve signing material through a reusable signer helper (`registry-signer.ts`) that derives the public key from `REGISTRY_SIGNING_KEY` and matches it to an `active` `kid` in `REGISTRY_SIGNING_KEYS` before signing.
- Keep AIT `iss` deterministic from environment mapping (`development`/`test` -> `https://dev.registry.clawdentity.com`, `production` -> `https://registry.clawdentity.com`) rather than request-origin inference.
- Bootstrap agent auth refresh material in the same mutation unit as agent creation by inserting an active `agent_auth_sessions` row.
- Response shape is `{ agent, ait, agentAuth }` where `agentAuth` returns short-lived access credentials and rotating refresh credentials.

## Agent Registration Helpers
- Keep `agent-registration.ts` responsibilities grouped by validation/parsing, challenge lifecycle, proof verification, and agent/token builders so each module can be split without changing behavior.
- Share the parsing helpers with any other routes that must reuse the same error exposure (name, framework, key, TTL, challenge fields) and keep environment-aware detail toggles centralized near `shouldExposeVerboseErrors`.
- Any refactor that splits this file should still surface `buildAgentRegistrationChallenge`, `verifyAgentRegistrationOwnershipProof`, `buildAgentRegistrationFromParsed`, `buildAgentReissue`, and `resolveRegistryIssuer` from a single barrel so callers need not change.
- Tests `apps/registry/src/server.test/agent-registration-challenge.test.ts` (challenge creation + persistence) and `apps/registry/src/server.test/agent-registration-create.test.ts` (payload validation, proof verification, error exposure, and issue response) are the canonical guards for this module—keep them green when moving logic into discrete modules.

## POST /v1/agents/auth/refresh Contract
- Public endpoint (no PAT): auth is agent-scoped via `Authorization: Claw <AIT>` + PoP headers + refresh token payload.
- Apply per-client-IP throttling and return `429 RATE_LIMIT_EXCEEDED` before auth parsing when over budget.
- Verify AIT against active registry signing keys and enforce deterministic issuer mapping for environment.
- Verify PoP using canonical request inputs and public key from AIT `cnf`.
- Enforce timestamp skew checks for replay-window reduction.
- Require payload `{ refreshToken }` and validate marker format (`clw_rft_`).
- Enforce single-active-session rotation semantics:
  - refresh token must match current active session hash/prefix
  - expired refresh token transitions session to `revoked`
  - successful refresh rotates both refresh/access credentials with a guarded update
- Insert audit events in `agent_auth_events` for `refreshed`, `revoked`, and `refresh_rejected`.

## POST /v1/agents/auth/validate Contract
- Public endpoint used by proxy runtime auth enforcement; request must include `x-claw-agent-access` and JSON payload `{ agentDid, aitJti }`.
- Apply per-client-IP throttling and return `429 RATE_LIMIT_EXCEEDED` before payload/auth validation when over budget.
- Validate `agentDid` + `aitJti` against active agent state (`agents.status=active`, `agents.current_jti` match).
- Validate access token against active session hash/prefix material with constant-time comparison.
- Expired access credentials must return `401 AGENT_AUTH_VALIDATE_EXPIRED` without rotating refresh credentials.
- Successful validation must update `agent_auth_sessions.access_last_used_at` and return `204`.
- Treat the `access_last_used_at` write as a guarded mutation: if the update matches zero rows, fail closed with `401 AGENT_AUTH_VALIDATE_UNAUTHORIZED` to prevent race-window acceptance after concurrent refresh/revoke.

## DELETE /v1/agents/:id Contract
- Require PAT auth via `createApiKeyAuth`; only the caller-owned agent may be revoked.
- Validate `:id` as ULID in `agent-revocation.ts`; path validation errors must be environment-aware via `shouldExposeVerboseErrors`.
- For unknown IDs or foreign-owned IDs, return `404 AGENT_NOT_FOUND` (single not-found behavior to avoid ownership leaks).
- Keep revocation idempotent:
  - return `204` when agent is already `revoked`
  - return `204` after first successful revoke
- If an owned active agent has no `current_jti`, fail with `409 AGENT_REVOKE_INVALID_STATE` rather than writing a partial revocation.
- Perform state changes in one DB transaction:
- update `agents.status` to `revoked` and `agents.updated_at` to `nowIso()`
- insert `revocations` row using the previous `current_jti`
- revoke active `agent_auth_sessions` row for the same agent and write `agent_auth_events` entry with reason `agent_revoked`.

## DELETE /v1/agents/:id/auth/revoke Contract
- Require PAT auth via `createApiKeyAuth`; only the caller-owned agent may be targeted.
- Validate `:id` with the same ULID path parser used by revoke/reissue flows.
- Return `404 AGENT_NOT_FOUND` for unknown/foreign agents.
- Revoke active `agent_auth_sessions` rows idempotently (`204` if already revoked/missing).
- Write `agent_auth_events` entry with reason `owner_auth_revoke` on first successful revoke.

## POST /v1/agents/:id/reissue Contract
- Require PAT auth via `createApiKeyAuth`; only the caller-owned agent may be reissued.
- Reuse `parseAgentRevokePath` for ULID path validation and preserve environment-aware error exposure.
- Return `404 AGENT_NOT_FOUND` for unknown IDs or foreign-owned IDs (single not-found behavior to avoid ownership leaks).
- Reissue only active agents:
  - if agent status is `revoked`, return `409 AGENT_REISSUE_INVALID_STATE`
  - if owned active agent has no `current_jti`, return `409 AGENT_REISSUE_INVALID_STATE`
- Keep one active token invariant in one DB transaction:
  - update must be optimistic and state-guarded (`id` + expected `status=active` + expected previous `current_jti`) so concurrent revoke/reissue cannot mint multiple valid AITs
  - fail with `409 AGENT_REISSUE_INVALID_STATE` when the guarded update matches zero rows (state changed concurrently)
  - update `agents.current_jti`, `agents.expires_at`, `agents.updated_at` (and keep status `active`)
  - insert revocation row for the previous `current_jti`
- Reissue rotates token identity, not privileges:
  - keep replacement AIT `exp` capped to prior `agents.expires_at` when that expiry is still in the future
  - do not round near-expiry windows up to full days during rotation
- Sign replacement AIT using existing registry signer/keyset flow and deterministic issuer mapping.
- Response shape is `{ agent, ait }`; `agent.currentJti` must match the returned AIT `jti`.
