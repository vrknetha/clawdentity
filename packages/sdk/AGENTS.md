# AGENTS.md (packages/sdk)

## Purpose
- Host shared runtime helpers used across registry, proxy, and CLI.
- Keep cross-cutting concerns consistent without coupling to platform-specific internals.

## Shared Modules
- `logging`: structured JSON logging with contextual fields.
- `exceptions`: `AppError` and global Hono error handling with stable error envelopes.
- `datetime`: UTC-only helpers for expiry and date arithmetic.
- `config`: schema-validated runtime config parsing.
- `request-context`: request ID extraction/generation and propagation.

## Design Rules
- Keep helpers Cloudflare-compatible and local-runtime-compatible.
- Prefer small wrappers with explicit contracts over heavy framework abstractions.
- Avoid leaking secrets in logs and error payloads.
- Keep all parse/validation errors explicit and deterministic.

## Testing Rules
- Unit test each shared module.
- Validate error codes/envelopes and request ID behavior.
- Keep tests deterministic and offline.
