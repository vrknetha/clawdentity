# AGENTS.md (crates/tests/local/mock-proxy/src)

## Scope
- Applies to local mock proxy harness code.

## DID Rules
- Use `did:cdi` for fallback/generated agent identities.
- Keep generated fallback DIDs valid and parseable by core frame validators.

## Relay Harness
- Preserve simple in-memory routing/queue behavior for deterministic tests.
- Keep websocket/session behavior minimal and explicit; avoid hidden side effects.
