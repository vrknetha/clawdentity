# AGENTS.md (crates/clawdentity-core/src/connector)

## Purpose
- Guard the Rust connector service/runtime integration points.

## Rules
- Generated service definitions must pass explicit state roots (`--home-dir`) for isolated-home runs.
- OpenClaw provider setup may best-effort spawn `clawdentity connector start` for loopback targets, so connector startup paths must keep working without service managers in local Docker/container flows and must report action-required when runtime health still does not come up.
- Service install/uninstall must stay idempotent across macOS launchd and Linux systemd.
- Connector websocket reconnects must rebuild signed auth headers on every dial attempt; never reuse stale `X-Claw-Timestamp` / nonce material across reconnects.
- OpenClaw inbound relay delivery must preserve user-visible chat behavior: prefer `/hooks/wake`-style main-session ingress for peer messages, and only use isolated `/hooks/agent` flows when the product explicitly wants a separate hook session.
- Keep connector helpers `clippy -D warnings` clean, especially `format!` calls that can use inline named arguments.
- Keep connector runtime contracts backward compatible with published OpenClaw relay transform payloads unless a coordinated release updates both sides.
- Keep websocket client dependencies compiled with TLS support; production proxy connectivity requires `wss://` and must never rely on plaintext-only websocket builds.
