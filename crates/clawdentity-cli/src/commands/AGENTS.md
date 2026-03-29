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
- `onboarding run` is the primary operator UX flow; keep it stateful and resumable via `~/.clawdentity/onboarding-session.json` with stable machine states (`cli_ready`, `identity_ready`, `provider_ready`, `pairing_pending`, `paired`, `messaging_ready`).
- `onboarding run` must remain idempotent on re-runs and should only ask for missing mandatory inputs (`onboarding_code`, `display_name`, `agent_name`, `peer_ticket`) while auto-repairing provider runtime when `--repair` is used.
- Keep onboarding implementation split by responsibility: `onboarding.rs` owns command/session orchestration and lightweight helpers, while `onboarding/onboarding_flow.rs` owns provider/pairing/messaging execution steps.
- Best-effort OpenClaw wake notifications emitted during onboarding must use short HTTP client timeouts so optional notifications never stall the primary pairing/messaging readiness path.
- Pair-accepted side effects in connector inbound handling must stay gated by trusted relay provenance metadata (`deliverySource=proxy.events.queue.pair_accepted`), never by user payload content alone.
- Keep `provider setup --for openclaw --openclaw-agent-id <id>` wired end-to-end into core setup options; default mapping remains `main` when omitted.
- OpenClaw agent routing is opt-in behavior tied to `/hooks/agent`; CLI defaults and docs must continue treating `/hooks/wake` as the default inbound hook path.
- Connector inbound failure handling must not leave stale `inbound_pending` rows forever: successful redelivery must clear pending state, and retry/backoff must either reschedule or dead-letter exhausted items.
- If inbound delivery fails but the connector successfully persists the frame for local retry, ACK the relay as accepted so only one retry path exists.
- Wake payloads must not force `sessionId: "main"`; only send `sessionId` when the inbound payload explicitly carries one so OpenClaw's configured default session stays in control.
- Provider-specific command docs and help text must use `--for <provider>`.
- Commands that accept `--home-dir` must pass that exact state root through every follow-up verification step; do not install into one home and verify another.
- `provider setup` output must reflect setup readiness truthfully; when core returns action-required, the CLI must not print “completed”.
- Structural line-budget rules are hard gates; proactively split files/functions before crossing limits, and only use `#[allow(clippy::too_many_lines)]` on orchestrators when a split would reduce readability.
- Keep command implementations `clippy -D warnings` clean; fold oversized argument lists into small input structs instead of sprinkling `allow` attributes.
