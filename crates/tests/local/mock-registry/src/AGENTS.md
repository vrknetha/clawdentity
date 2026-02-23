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

## Compatibility
- Do not reintroduce legacy `did:claw:*` fixtures.
