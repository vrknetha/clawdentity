# AGENTS.md (crates/clawdentity-core/src/registry)

## Purpose
- Keep Rust registry clients compatible with the hosted registry API.

## Rules
- Optional request fields must be omitted when unset instead of serialized as `null` unless the registry contract explicitly allows nulls.
- Keep blocking registry-client code out of async contexts unless wrapped with a blocking boundary.
