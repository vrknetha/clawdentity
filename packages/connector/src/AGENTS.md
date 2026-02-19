# AGENTS.md (packages/connector/src)

## Source Layout
- Keep frame schema definitions in `frames.ts` and validate every inbound/outbound frame through parser helpers.
- Keep websocket lifecycle + ack behavior in `client.ts`.
- Keep local runtime orchestration (`/v1/outbound`, `/v1/status`, auth refresh, replay loop) in `runtime.ts`.
- Keep durable inbound storage logic isolated in `inbound-inbox.ts`.

## Inbound Durability Rules
- Connector must persist inbound relay payloads before sending `deliver_ack accepted=true`.
- Persist connector inbox state as atomic JSON index + append-only JSONL events under `agents/<agent>/inbound-inbox/`.
- Inbox dedupe key is request/frame id; duplicates must not create extra pending entries.
- Replay must continue after runtime restarts by loading pending entries from inbox index at startup.
- Do not drop pending entries on transient replay failures; reschedule with bounded backoff.

## Replay/Health Rules
- Keep replay configuration environment-driven via `CONNECTOR_INBOUND_*` vars with safe defaults from `constants.ts`.
- `/v1/status` must include websocket state and inbound replay health (`pendingCount`, `oldestPendingAt`, replay activity/error, hook status).
- On inbox/status read failures, return explicit structured errors instead of crashing runtime.

## Testing Rules
- `inbound-inbox.test.ts` must cover persistence, dedupe, cap enforcement, and replay bookkeeping transitions.
- `client.test.ts` must cover both delivery modes:
  - direct local OpenClaw delivery fallback
  - injected inbound persistence handler ack path
