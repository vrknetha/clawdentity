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

## Validation
- Run `pnpm -F @clawdentity/registry run test` after changing routes or config loading.
- Run `pnpm -F @clawdentity/registry run typecheck` before commit.
- When using fake D1 adapters in route tests, make select responses honor bound parameters so query-shape regressions are caught.

## GET /v1/agents Contract
- Require PAT auth via `createApiKeyAuth`; only caller-owned agents may be returned.
- Keep query parsing in `agentList.ts` to avoid duplicating validation rules in route handlers.
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
- Keep request parsing and validation in a reusable helper module (`agentRegistration.ts`) so future routes can share the same constraints without duplicating schema logic.
- Keep error detail exposure environment-aware via `shouldExposeVerboseErrors` (shared SDK helper path): return generic messages without internals in `production`, but include validation/config details in `development`/`test` for debugging.
- Persist `agents.current_jti` and `agents.expires_at` on insert; generated AIT claims (`jti`, `exp`) must stay in sync with those persisted values.
- Use shared SDK datetime helpers (`nowIso`, `addSeconds`) for issuance/expiry math instead of ad-hoc `Date.now()` arithmetic in route logic.
- Resolve signing material through a reusable signer helper (`registrySigner.ts`) that derives the public key from `REGISTRY_SIGNING_KEY` and matches it to an `active` `kid` in `REGISTRY_SIGNING_KEYS` before signing.
- Keep AIT `iss` deterministic from environment mapping (`development`/`test` -> `https://dev.api.clawdentity.com`, `production` -> `https://api.clawdentity.com`) rather than request-origin inference.
- Response shape remains `{ agent, ait }`; the token must be verifiable with the public keyset returned by `/.well-known/claw-keys.json`.
