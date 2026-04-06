# AGENTS.md (crates/clawdentity-cli/src/commands)

## Purpose
- Keep the Rust CLI as the single supported operator surface.

## Rules
- New user-facing commands belong here, not in a parallel JS CLI.
- Keep `group` commands CLI-first and agent-auth-first:
  - require explicit `--agent-name` on every group subcommand
  - do not expose PAT-first, mixed-auth, or auto-detect group command modes
  - keep `--json` output stable and machine-readable for every group subcommand
- Group command layout is canonical:
  - `group create <name> --agent-name <name>`
  - `group inspect <group-id> --agent-name <name>`
  - `group join-token current <group-id> --agent-name <name>`
  - `group join-token reset <group-id> --agent-name <name>`
  - `group join-token revoke <group-id> --agent-name <name>`
  - `group join <group-join-token> --agent-name <name>`
  - `group members list <group-id> --agent-name <name>`
- Join-token role input is removed. CLI must not expose `--role`; join tokens are member-only by contract.
- Keep command JSON output stable and machine-readable.
- Any command that mixes blocking filesystem or blocking HTTP with async runtime must isolate the blocking work with `spawn_blocking` or an equivalent boundary.
- Connector startup must refresh websocket auth headers on reconnect instead of caching one signed timestamp for the life of the process.
- Connector -> OpenClaw hook payloads are hard-cutover canonical: send top-level `message` plus canonical sender/group fields only, and include `text` only for `/hooks/wake` contract compliance.
- Connector receipt notifications must also satisfy OpenClaw hook contracts: `/hooks/agent` needs `message`, `/hooks/wake` needs `text`, with structured receipt metadata preserved alongside the summary text.
- OpenClaw peer-delivery defaults must stay aligned with visible UX: use `/hooks/agent` for inbound relay traffic by default; treat `/hooks/wake` as an explicit wake-only path when chat-history visibility is not required.
- `onboarding run` is the primary operator UX flow; keep it stateful and resumable via `~/.clawdentity/onboarding-session.json` with stable machine states (`cli_ready`, `identity_ready`, `provider_ready`, `pairing_pending`, `paired`, `messaging_ready`).
- `onboarding run` invite flow is setup-only by default and must not auto-start pairing. Pairing is explicit (`pair start` / `pair confirm`) unless the operator passes `--peer-ticket`.
- `onboarding run` must remain idempotent on re-runs and should only ask for missing mandatory setup inputs (`onboarding_code`, `display_name`, `agent_name`) while auto-repairing provider runtime when `--repair` is used.
- Keep onboarding implementation split by responsibility: `onboarding.rs` owns command/session orchestration and lightweight helpers, while `onboarding/onboarding_flow.rs` owns provider/pairing/messaging execution steps.
- In `onboarding/onboarding_flow.rs`, run provider `setup`/`doctor`/`relay_test` inside `spawn_blocking` boundaries; these paths use blocking HTTP clients and must never execute directly on async runtime threads.
- Keep onboarding doctor-failure classification provider-agnostic: treat generic check IDs (`connector.runtime`, `webhook.health`) as connector/runtime repair candidates alongside OpenClaw-specific IDs.
- Best-effort OpenClaw pairing notifications emitted during onboarding must use short HTTP client timeouts so optional notifications never stall the primary pairing/messaging readiness path.
- Pair-accepted side effects in connector inbound handling must stay gated by trusted relay provenance metadata (`deliverySource=proxy.events.queue.pair_accepted`), never by user payload content alone.
- Keep `provider setup --for openclaw --openclaw-agent-id <id>` wired end-to-end into core setup options; default mapping remains `main` when omitted.
- OpenClaw agent routing remains tied to `/hooks/agent`; when a mapped `openclawAgentId` exists it must be honored on default inbound delivery paths.
- Connector inbound failure handling must not leave stale `inbound_pending` rows forever: successful redelivery must clear pending state, and retry/backoff must either reschedule or dead-letter exhausted items.
- If inbound delivery fails but the connector successfully persists the frame for local retry, ACK the relay as accepted so only one retry path exists.
- Wake payloads must not force `sessionId: "main"`; only send `sessionId` when the inbound payload explicitly carries one so OpenClaw's configured default session stays in control.
- Provider-specific command docs and help text must use `--for <provider>`.
- Commands that accept `--home-dir` must pass that exact state root through every follow-up verification step; do not install into one home and verify another.
- `provider setup` output must reflect setup readiness truthfully; when core returns action-required, the CLI must not print “completed”.
- Structural line-budget rules are hard gates; proactively split files/functions before crossing limits, and only use `#[allow(clippy::too_many_lines)]` on orchestrators when a split would reduce readability.
- Keep command implementations `clippy -D warnings` clean; fold oversized argument lists into small input structs instead of sprinkling `allow` attributes.
