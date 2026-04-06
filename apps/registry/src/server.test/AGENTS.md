# AGENTS.md (apps/registry/src/server.test)

## Scope
- Applies to registry HTTP route and onboarding tests under `apps/registry/src/server.test`.

## Rules
- Add a regression test for every onboarding state transition change (`active`, `expired`, `redeemed`) so GitHub starter-pass behavior cannot silently drift.
- Cover both HTTPS and plain-HTTP cookie behavior when route logic depends on cookie flags or callback state validation.
- Prefer asserting redirect fragment fields (`code`, `displayName`, `providerLogin`, `expiresAt`) in onboarding tests, because that fragment is the public contract consumed by landing.
- When DB mutation-shape handling changes, include at least one route-level regression test that proves the API returns a controlled `500` envelope instead of leaking raw failures.
- Group-route tests must include one regression for schema-readiness failures on new columns (for example `group_join_tokens.token_ciphertext`) so missing migrations return explicit `CONFIG_VALIDATION_FAILED` guidance.
- Group join-token reset tests must assert deterministic ordering: replacement insert is attempted before any `revoked_at` update, so an insert failure cannot revoke existing active tokens.
