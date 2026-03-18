# AGENTS.md (apps/registry/src/onboarding)

## Purpose
- Keep public onboarding flows deterministic, stateless where possible, and fail-closed.

## Rules
- GitHub onboarding in v1 is starter-pass issuance only; do not turn this folder into a long-lived human session system.
- OAuth state must be protected by an HttpOnly signed cookie and compared against the callback `state` query parameter.
- Keep callback redirects fragment-based so starter-pass codes are not sent to the landing origin in query strings or server logs.
- Reuse an existing active starter pass for the same GitHub subject when possible; never mint a second pass after a redeemed/expired pass exists.
- When onboarding config is missing, fail with a stable disabled error code instead of partially running OAuth.
- Keep provider-specific fetch/parsing logic small and isolated so additional providers can be added without leaking GitHub assumptions across routes.
- Centralize repeated onboarding error constructors (for example invalid OAuth state) behind small helpers so message/code/status cannot drift across branches.
