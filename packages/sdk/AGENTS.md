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
- `jwt/crl-jwt`: CRL JWT helpers with EdDSA signing, header consistency checks, and tamper-detection test coverage.
- `http/sign` + `http/verify`: PoP request signing and verification that binds method, path+query, timestamp, nonce, and body hash.
- `security/nonce-cache`: in-memory TTL nonce replay protection keyed by `agentDid + nonce`.
- Tests should prove tamper cases (payload change, header kid swap, signature corruption).

## Design Rules
- Keep helpers Cloudflare-compatible and local-runtime-compatible.
- Prefer small wrappers with explicit contracts over heavy framework abstractions.
- Avoid leaking secrets in logs and error payloads.
- Keep all parse/validation errors explicit and deterministic.
- Keep cryptography APIs byte-first (`Uint8Array`) and runtime-portable.
- Reuse protocol base64url helpers as the single source of truth; do not duplicate encoding logic in SDK.
- Keep CRL claim schema authority in `@clawdentity/protocol` (`crl.ts`); SDK JWT helpers should avoid duplicating claim-validation rules.
- Never log secret keys or raw signature material.
- Enforce AIT JWT security invariants in verification: `alg=EdDSA`, `typ=AIT`, and `kid` lookup against registry keys.
- Always parse CRL JWT payloads through protocol `parseCrlClaims` after signature verification so schema invariants (revocations non-empty, DID/ULID checks) are enforced.
- For HTTP signing errors, keep user-facing messages static and send extra context through `AppError.details`.
- Enforce Ed25519 key lengths at SDK boundaries (`secretKey` 32 bytes, `publicKey` 32 bytes) so misconfiguration returns stable `AppError` codes.
- Treat any decoded PoP proof that is not 64 bytes as `HTTP_SIGNATURE_INVALID_PROOF`.

## Testing Rules
- Unit test each shared module.
- Validate error codes/envelopes and request ID behavior.
- Keep tests deterministic and offline.
- Crypto tests must include explicit negative verification cases (wrong message/signature/key).
- JWT tests must include sign/verify happy path and failure paths for issuer mismatch and missing/unknown `kid`.
- HTTP signing tests must include sign/verify happy path and explicit failures when method, path, body, or timestamp are altered.
- Nonce cache tests must include duplicate nonce rejection within TTL and acceptance after TTL expiry.
