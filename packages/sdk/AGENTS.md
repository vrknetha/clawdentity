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
- `crypto/ed25519`: byte-first keypair/sign/verify helpers for PoP and token workflows.
- `jwt/ait-jwt`: AIT JWS signing and verification with strict header and issuer checks.

## Design Rules
- Keep helpers Cloudflare-compatible and local-runtime-compatible.
- Prefer small wrappers with explicit contracts over heavy framework abstractions.
- Avoid leaking secrets in logs and error payloads.
- Keep all parse/validation errors explicit and deterministic.
- Keep cryptography APIs byte-first (`Uint8Array`) and runtime-portable.
- Reuse protocol base64url helpers as the single source of truth; do not duplicate encoding logic in SDK.
- Never log secret keys or raw signature material.
- Enforce AIT JWT security invariants in verification: `alg=EdDSA`, `typ=AIT`, and `kid` lookup against registry keys.

## Testing Rules
- Unit test each shared module.
- Validate error codes/envelopes and request ID behavior.
- Keep tests deterministic and offline.
- Crypto tests must include explicit negative verification cases (wrong message/signature/key).
- JWT tests must include sign/verify happy path and failure paths for issuer mismatch and missing/unknown `kid`.
