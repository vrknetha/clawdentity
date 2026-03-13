# AGENTS.md (crates/tests/local/mock-registry/src)

## Scope
- Applies to local mock registry test harness code.

## DID / Token Rules
- Emit only `did:cdi` values from mock identity and agent issuance.
- Derive DID authority from `state.registry_url` host for issued mock DIDs.
- Keep `iss` and DID authority aligned in mock AIT/CRL payloads.

## Test Harness Behavior
- Maintain deterministic, lightweight mocks; avoid introducing network dependencies beyond local test server behavior.
- Keep API responses close to real registry contract shape (`camelCase` fields, status codes, token envelopes).
- Prefer small helper functions for token parsing/signing to avoid duplicated logic.
- When registry onboarding adds parallel endpoints with the same payload/response contract, expose both paths in the mock so CLI routing tests exercise real endpoint selection.

## Compatibility
- Do not reintroduce older `did:claw:*` fixtures.
