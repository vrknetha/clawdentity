# AGENTS.md (apps/proxy/src)

## Source Layout
- Keep `index.ts` as runtime bootstrap surface and version export.
- Keep runtime env parsing and defaults in `config.ts`; do not scatter `process.env` reads across handlers.
- Keep HTTP app/startup concerns in `server.ts`; use `bin.ts` as process entrypoint for Node runtime startup.
- Keep inbound auth verification in `auth-middleware.ts` with focused helpers for token parsing, registry material loading, CRL checks, and replay protection.
- Keep `.env` fallback loading and OpenClaw config (`hooks.token`) fallback logic inside `config.ts` so runtime behavior is deterministic.
- Keep fallback semantics consistent across merge + parse stages: empty/whitespace env values are treated as missing, so non-empty `.env`/file values can be used.
- Do not derive runtime environment from `NODE_ENV`; use validated `ENVIRONMENT` from proxy config.

## Config Error Handling
- Convert parse failures to `ProxyConfigError` with code `CONFIG_VALIDATION_FAILED`.
- Keep error details field-focused (`fieldErrors` / `formErrors`) and avoid exposing secrets.

## Maintainability
- Prefer schema-driven parsing with small pure helpers for coercion/overrides.
- Keep CRL defaults centralized as exported constants in `config.ts`; do not duplicate timing literals across modules.
- Keep server middleware composable and single-responsibility to reduce churn in later T27-T31 auth/forwarding work.
- Keep auth failure semantics stable: auth-invalid requests map to `401`; registry keyset outages map to `503`; CRL outages map to `503` when stale behavior is `fail-closed`.
