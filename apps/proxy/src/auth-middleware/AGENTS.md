# AGENTS.md (apps/proxy/src/auth-middleware)

## Purpose
- Keep proxy auth verification modular, testable, and failure-mode explicit.

## Module ownership
- `middleware.ts`: orchestration only (verification flow and context wiring).
- `request-auth.ts`: header parsing, timestamp skew validation, proof input shaping.
- `registry-keys.ts`: registry key payload parsing + verification-key projection.
- `url.ts`: registry URL normalization, issuer resolution, path helpers.
- `errors.ts`: standardized auth/dependency error constructors.
- `types.ts`: shared types and defaults.

## Rules
- Keep error codes/messages stable; route tests depend on them.
- Prefer pure helpers in leaf modules and inject side-effectful dependencies (`fetch`, caches, clock) from `middleware.ts`.
- Do not mix registry fetch/parsing logic into request-header helpers.
- Keep replay/nonce and CRL decisions fail-safe and explicit.
