# AGENTS.md (apps/registry/src)

## Purpose
- Keep runtime entrypoints and route contracts consistent for the registry worker.

## Entrypoints
- `server.ts` is the Cloudflare Worker runtime entrypoint.
- `index.ts` should re-export `server.ts` for package build/test compatibility.

## Health Contract
- `/health` must return HTTP 200 with `{ status, version, environment }` on valid config.
- Invalid runtime config must fail through the shared error handler and return `CONFIG_VALIDATION_FAILED`.

## Registry Keyset Contract
- `/.well-known/claw-keys.json` is a public endpoint and must remain unauthenticated.
- Return `keys[]` entries with `kid`, `alg`, `crv`, `x`, and `status` so SDK/offline verifiers can consume directly.
- Keep cache headers explicit and short-lived (`max-age=300` + `stale-while-revalidate`) to balance key rotation with client efficiency.

## CRL Snapshot Contract
- `GET /v1/crl` is a public endpoint and must remain unauthenticated so SDK/proxy clients can refresh revocation state without PAT bootstrap dependencies.
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

## Validation
- Run `pnpm -F @clawdentity/registry run test` after changing routes or config loading.
- Run `pnpm -F @clawdentity/registry run typecheck` before commit.
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

## POST /v1/agents Contract
- Require PAT auth via `createApiKeyAuth`; unauthenticated calls must fail before payload parsing.
- Validate request payload fields with explicit rules:
  - `name`: protocol-compatible agent name validation.
  - `framework`: optional; default to `openclaw` when omitted.
  - `publicKey`: base64url Ed25519 key that decodes to 32 bytes.
  - `ttlDays`: optional; default `30`; allow only integer range `1..90`.
- Keep request parsing and validation in a reusable helper module (`agent-registration.ts`) so future routes can share the same constraints without duplicating schema logic.
- Keep error detail exposure environment-aware via `shouldExposeVerboseErrors` (shared SDK helper path): return generic messages without internals in `production`, but include validation/config details in `development`/`test` for debugging.
- Persist `agents.current_jti` and `agents.expires_at` on insert; generated AIT claims (`jti`, `exp`) must stay in sync with those persisted values.
- Use shared SDK datetime helpers (`nowIso`, `addSeconds`) for issuance/expiry math instead of ad-hoc `Date.now()` arithmetic in route logic.
- Resolve signing material through a reusable signer helper (`registry-signer.ts`) that derives the public key from `REGISTRY_SIGNING_KEY` and matches it to an `active` `kid` in `REGISTRY_SIGNING_KEYS` before signing.
- Keep AIT `iss` deterministic from environment mapping (`development`/`test` -> `https://dev.api.clawdentity.com`, `production` -> `https://api.clawdentity.com`) rather than request-origin inference.
- Response shape remains `{ agent, ait }`; the token must be verifiable with the public keyset returned by `/.well-known/claw-keys.json`.

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
