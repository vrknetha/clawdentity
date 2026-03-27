# AGENTS.md (crates/clawdentity-cli/src/commands)

## Purpose
- Keep the Rust CLI as the single supported operator surface.

## Rules
- New user-facing commands belong here, not in a parallel JS CLI.
- Keep command JSON output stable and machine-readable.
- Any command that mixes blocking filesystem or blocking HTTP with async runtime must isolate the blocking work with `spawn_blocking` or an equivalent boundary.
- Connector startup must refresh websocket auth headers on reconnect instead of caching one signed timestamp for the life of the process.
- Connector -> OpenClaw hook payloads must send top-level `message`; keep `content` only as a compatibility alias, never as the sole field, and mirror user-visible wake text into `message` when targeting `/hooks/wake`.
- Connector receipt notifications must also satisfy OpenClaw hook contracts: `/hooks/agent` needs `message`, `/hooks/wake` needs `text`, with structured receipt metadata preserved alongside the summary text.
- OpenClaw peer-delivery defaults must stay aligned with visible UX: `/hooks/wake` for inbound relay traffic, with sender context rendered into `text`; reserve `/hooks/agent` for explicit isolated-hook workflows.
- Connector inbound failure handling must not leave stale `inbound_pending` rows forever: successful redelivery must clear pending state, and retry/backoff must either reschedule or dead-letter exhausted items.
- If inbound delivery fails but the connector successfully persists the frame for local retry, ACK the relay as accepted so only one retry path exists.
- Wake payloads must not force `sessionId: "main"`; only send `sessionId` when the inbound payload explicitly carries one so OpenClaw's configured default session stays in control.
- Provider-specific command docs and help text must use `--for <provider>`.
- Commands that accept `--home-dir` must pass that exact state root through every follow-up verification step; do not install into one home and verify another.
- `provider setup` output must reflect setup readiness truthfully; when core returns action-required, the CLI must not print “completed”.
- Keep command implementations `clippy -D warnings` clean; fold oversized argument lists into small input structs instead of sprinkling `allow` attributes.
