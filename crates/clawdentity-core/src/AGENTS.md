# AGENTS.md (crates/clawdentity-core/src)

## Scope
- Applies to all Rust modules under `crates/clawdentity-core/src`.

## DID Rules
- Use only `did:cdi:<authority>:<entity>:<ulid>`.
- `<entity>` must be `agent` or `human`.
- Do not introduce `did:claw:*` values anywhere in production code.
- Parse and validate DIDs through `identity::did` helpers (`parse_did`, `parse_agent_did`, `parse_human_did`).
- Build DIDs through helpers (`make_*_did` / `new_*_did`) instead of string concatenation.

## Issuer / Authority Invariants
- For AIT and CRL verification, issuer URL host must match DID authority.
- Derive DID authority from URL host using `did_authority_from_url`.
- Do not hardcode issuer host special-cases in auth paths.

## Testing Guidelines
- Test fixtures should use valid ULIDs in DID strings.
- If tests use local/mock issuers (localhost or IP), keep DID authority aligned with that issuer host.
- Keep parser/validator tests focused on explicit rejection reasons (method, authority, entity, ULID).

## Quality
- Keep modules small and composable; prefer helper functions over duplicated parsing logic.
- Preserve fail-closed behavior for auth/verification paths unless explicitly documented otherwise.
