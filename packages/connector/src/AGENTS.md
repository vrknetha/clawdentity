# AGENTS.md (packages/connector/src)

## Source Layout
- Keep frame schema definitions in `frames.ts` and validate every inbound/outbound frame through parser helpers.
- Keep websocket lifecycle + ack behavior in `client.ts`.
- Keep local runtime orchestration (`/v1/outbound`, `/v1/status`, auth refresh, replay loop) in `runtime.ts`.
- Keep durable inbound storage logic isolated in `inbound-inbox.ts`.

## Inbound Durability Rules
- Connector must persist inbound relay payloads before sending `deliver_ack accepted=true`.
- Persist connector inbox state as atomic JSON index + append-only JSONL events under `agents/<agent>/inbound-inbox/`.
- Inbound inbox index schema is `version: 2` with explicit `pendingByRequestId` + `deadLetterByRequestId`; do not add backward-compat parsing paths for older index versions.
- Inbox dedupe key is request/frame id; duplicates must not create extra pending entries.
- Replay must continue after runtime restarts by loading pending entries from inbox index at startup.
- Do not drop pending entries on transient replay failures; reschedule with bounded backoff.
- Non-retryable replay failures must move to dead-letter after `CONNECTOR_INBOUND_DEAD_LETTER_NON_RETRYABLE_MAX_ATTEMPTS`.
- Dead-letter operations (`listDeadLetter`, `replayDeadLetter`, `purgeDeadLetter`) must update bytes/count accounting atomically with index writes.
- Keep index writes guarded by the local advisory lock file (`index.lock`) to avoid concurrent writer corruption across processes.
- Keep event log growth bounded via rotation (`eventsMaxBytes`, `eventsMaxFiles`) rather than unbounded `events.jsonl` growth.
- Preserve inbound `conversationId` and `replyTo` metadata through inbox persistence and replay delivery.

## Replay/Health Rules
- Keep replay configuration environment-driven via `CONNECTOR_INBOUND_*` vars with safe defaults from `constants.ts`.
- `/v1/status` must use the nested contract:
  - `websocket.{connected,connectAttempts,reconnectCount,uptimeMs,lastConnectedAt}`
  - `inbound.pending`
  - `inbound.deadLetter`
  - `inbound.replay`
  - `inbound.openclawHook`
  - `metrics.{heartbeat,inboundDelivery,outboundQueue}`
- On inbox/status read failures, return explicit structured errors instead of crashing runtime.
- Keep connector runtime/inbox timestamps standardized via shared SDK datetime helpers (`nowUtcMs`, `toIso`, `nowIso`) instead of ad-hoc datetime formatting.
- Keep dead-letter operational endpoints stable:
  - `GET /v1/inbound/dead-letter`
  - `POST /v1/inbound/dead-letter/replay`
  - `POST /v1/inbound/dead-letter/purge`
- For dead-letter replay/purge targeting, treat omitted `requestIds` as "all", but treat `requestIds: []` (or empty after sanitization) as a no-op.
- For replay delivery callbacks, post signed receipts to peer proxies using `replyTo` with statuses `processed_by_openclaw` and `dead_lettered`, but only when `replyTo` points to trusted peer proxy origins and the relay receipt path.

## WebSocket Resilience Rules
- Keep websocket reconnect behavior centralized in `client.ts` (single cleanup path for close/error/unexpected-response/timeout).
- Keep default websocket connect timeout at `DEFAULT_CONNECT_TIMEOUT_MS` (15000ms) and heartbeat ack timeout at `DEFAULT_HEARTBEAT_ACK_TIMEOUT_MS` (60000ms).
- Track outbound heartbeat IDs and clear pending entries only when matching `heartbeat_ack` frames are received.
- If heartbeat ack timeout expires, disconnect and reconnect using the same reconnect policy used for other transport failures.
- Handle `unexpected-response` status codes from ws upgrade failures; for `401`, trigger `onAuthUpgradeRejected` and allow one immediate reconnect before normal backoff.
- Keep outbound enqueue buffering durable when configured via `outboundQueuePersistence`; load once before replaying queued frames and persist on enqueue/dequeue transitions.
- Keep websocket/client metrics in `ConnectorClient` (`getMetricsSnapshot`) so runtime health does not recompute transport stats ad hoc.

## Testing Rules
- `inbound-inbox.test.ts` must cover persistence, dedupe, cap enforcement, replay bookkeeping, dead-letter thresholding, dead-letter replay, and dead-letter purge transitions.
- `client.test.ts` must cover both delivery modes:
  - direct local OpenClaw delivery fallback
  - injected inbound persistence handler ack path
- `client.test.ts` must keep websocket lifecycle expectations compatible with non-persistent and persistent queue modes.
