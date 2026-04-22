# AGENTS.md (apps/proxy)

## Purpose
- Define conventions for the Clawdentity proxy app.

## Rules
- Keep config parsing centralized and fail-fast with clear validation errors.
- Keep trust verification pipeline deterministic: auth verify -> replay checks -> revocation checks -> trust checks -> rate limits.
- Keep queue consumers and relay session behavior idempotent and retry-safe.
- Keep runtime defaults explicit and environment-scoped (`local`, `development`, `production`).
- Keep `/health` unauthenticated and stable for deploy readiness.
- Avoid adding runtime-specific delivery assumptions to proxy behavior.
