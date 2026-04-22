# AGENTS.md (crates/clawdentity-core/src/connector)

## Purpose
- Guard Rust connector service/runtime behavior for the generic relay contract.

## Rules
- Service install/uninstall must stay idempotent across macOS launchd and Linux systemd.
- Generated service definitions must pass explicit state roots (`--home-dir`) for isolated-home runs.
- Connector websocket reconnects must rebuild signed auth headers on every dial attempt.
- Keep Rust connector frame contracts aligned with TypeScript in the same change.
- Keep delivery webhook behavior runtime-agnostic; do not add provider/platform branching.
