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
- On success, inject `ctx.human` for downstream handlers.
- Return auth failures through `AppError` with 401 status and stable codes.

## Verification
- Cover valid, invalid, and missing PAT paths in `server.test.ts`.
- Verify middleware updates `api_keys.last_used_at` on successful auth.
