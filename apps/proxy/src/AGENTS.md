# AGENTS.md (apps/proxy/src)

## Source Layout
- Keep `index.ts` as runtime bootstrap surface and version export.
- Keep runtime env parsing and defaults in `config.ts`; do not scatter `process.env` reads across handlers.
- Keep agent DID rate-limit env parsing in `config.ts` (`AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE`, `AGENT_RATE_LIMIT_WINDOW_MS`) and validate as positive integers.
- Keep HTTP app/startup concerns in `server.ts`; use `bin.ts` as process entrypoint for Node runtime startup.
- Keep inbound auth verification in `auth-middleware.ts` with focused helpers for token parsing, registry material loading, CRL checks, and replay protection.
- Keep per-agent DID throttling in `agent-rate-limit-middleware.ts`; do not blend rate-limit state or counters into `auth-middleware.ts`.
- Keep `.env` fallback loading and OpenClaw config (`hooks.token`) fallback logic inside `config.ts` so runtime behavior is deterministic.
- Keep fallback semantics consistent across merge + parse stages: empty/whitespace env values are treated as missing, so non-empty `.env`/file values can be used.
- Do not derive runtime environment from `NODE_ENV`; use validated `ENVIRONMENT` from proxy config.

## Config Error Handling
- Convert parse failures to `ProxyConfigError` with code `CONFIG_VALIDATION_FAILED`.
- Keep error details field-focused (`fieldErrors` / `formErrors`) and avoid exposing secrets.

## Maintainability
- Prefer schema-driven parsing with small pure helpers for coercion/overrides.
- Keep CRL defaults centralized as exported constants in `config.ts`; do not duplicate timing literals across modules.
- Keep allowlist schema strict and agent-first: reject unknown allowlist keys and require explicit `allowList.agents` membership after verification.
- Keep `ALLOW_ALL_VERIFIED` removed; fail fast when deprecated bypass flags are provided.
- Keep server middleware composable and single-responsibility to reduce churn in later T27-T31 auth/forwarding work.
- Keep `/hooks/agent` forwarding logic isolated in `agent-hook-route.ts`; `server.ts` should only compose middleware/routes.
- Keep auth failure semantics stable: auth-invalid requests map to `401`; verified-but-not-allowlisted requests map to `403`; registry keyset outages map to `503`; CRL outages map to `503` when stale behavior is `fail-closed`.
- Keep rate-limit failure semantics stable: verified requests over budget map to `429` with code `PROXY_RATE_LIMIT_EXCEEDED` and structured warn log event `proxy.rate_limit.exceeded`.
- Keep `X-Claw-Timestamp` parsing strict: accept digit-only unix-seconds strings and reject mixed/decimal formats.
- Keep AIT verification resilient to routine key rotation: retry once with a forced keyset refresh on `UNKNOWN_AIT_KID` before rejecting.
- Keep CRL verification resilient to routine key rotation: retry once with a forced keyset refresh on `UNKNOWN_CRL_KID` before dependency-failure mapping.
- Keep `/hooks/agent` input contract strict: require `Content-Type: application/json` and reject malformed JSON with explicit client errors.
- Keep `/hooks/agent` upstream failure mapping explicit: timeout errors -> `504`, network errors -> `502`, and never log `openclawHookToken` or request payload.
