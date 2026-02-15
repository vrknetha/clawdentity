# AGENTS.md (apps/proxy/src)

## Source Layout
- Keep `index.ts` as runtime bootstrap surface and version export.
- Keep runtime env parsing and defaults in `config.ts`; do not scatter `process.env` reads across handlers.
- Keep `.env` fallback loading and OpenClaw config (`hooks.token`) fallback logic inside `config.ts` so runtime behavior is deterministic.

## Config Error Handling
- Convert parse failures to `ProxyConfigError` with code `CONFIG_VALIDATION_FAILED`.
- Keep error details field-focused (`fieldErrors` / `formErrors`) and avoid exposing secrets.

## Maintainability
- Prefer schema-driven parsing with small pure helpers for coercion/overrides.
- Keep CRL defaults centralized as exported constants in `config.ts`; do not duplicate timing literals across modules.
