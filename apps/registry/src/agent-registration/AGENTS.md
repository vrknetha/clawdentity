# AGENTS.md (apps/registry/src/agent-registration)

## Purpose
- Keep agent-registration helpers modular, deterministic, and easy to test independently.

## Module Boundaries
- Keep shared registration constants and issuer resolution in `constants.ts`.
- Keep payload parsing/validation in `parsing.ts`; do not duplicate field validators across routes.
- Keep challenge construction logic in `challenge.ts` and preserve the challenge response contract.
- Keep ownership-proof verification in `proof.ts` with consistent replay/expiry/signature errors.
- Keep claim/agent object builders in `creation.ts`, including reissue expiry rules.
- Keep exported public surface centralized in `index.ts`, and keep `../agent-registration.ts` as the stable facade import path.

## Safety
- Preserve environment-aware validation error exposure rules (`shouldExposeVerboseErrors`) for parse failures.
- Preserve challenge nonce length, TTL, and proof canonicalization inputs exactly; changes here are auth-sensitive.
- Preserve reissue expiry behavior: do not extend lifetime beyond prior valid expiry when previous expiry is still active.
