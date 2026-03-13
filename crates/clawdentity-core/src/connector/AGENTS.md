# AGENTS.md (crates/clawdentity-core/src/connector)

## Purpose
- Guard the Rust connector service/runtime integration points.

## Rules
- Generated service definitions must pass explicit state roots (`--home-dir`) for isolated-home runs.
- Service install/uninstall must stay idempotent across macOS launchd and Linux systemd.
- Keep connector helpers `clippy -D warnings` clean, especially `format!` calls that can use inline named arguments.
- Keep connector runtime contracts backward compatible with published OpenClaw relay transform payloads unless a coordinated release updates both sides.
- Keep websocket client dependencies compiled with TLS support; production proxy connectivity requires `wss://` and must never rely on plaintext-only websocket builds.
