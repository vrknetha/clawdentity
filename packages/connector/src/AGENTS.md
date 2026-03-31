# AGENTS.md (packages/connector/src)

## Source Layout
- Keep frame schema definitions in `frames.ts` and validate every inbound/outbound frame through parser helpers.
- Keep `client.ts` as the stable public surface (`ConnectorClient` + exported client types) and route internal concerns through `client/` modules:
  - `client/types.ts` for externally consumed client types.
  - `client/helpers.ts` for shared pure helpers (event parsing, sanitization, normalization).
  - `client/inbound.ts` for parsed frame dispatch orchestration (`heartbeat`, `heartbeat_ack`, `deliver`, `receipt`).
  - `client/metrics.ts` for websocket uptime/reconnect and inbound ack-latency tracking.
  - `client/retry.ts` for reusable backoff math.
  - `client/heartbeat.ts` for heartbeat scheduling, ack tracking, and RTT metrics.
  - `client/queue.ts` for outbound queue + persistence orchestration.
  - `client/delivery.ts` for local OpenClaw delivery + retry behavior.
- Keep `runtime.ts` as the runtime entrypoint and wire internal concerns through `runtime/` modules:
  - `runtime/auth-lifecycle.ts` for in-memory auth state + refresh/sync orchestration.
  - `runtime/auth-storage.ts` for registry auth disk sync + atomic persistence.
  - `runtime/openclaw-hook-token.ts` for explicit-vs-runtime hook token precedence and sync.
  - `runtime/openclaw-probe.ts` for OpenClaw gateway liveness probing state transitions.
  - `runtime/openclaw.ts` for hook token discovery and abort-aware local hook delivery.
  - `runtime/policy.ts` for replay/probe configuration loading and retry-delay calculation.
  - `runtime/replay.ts` for inbound replay orchestration, lane scheduling, retry/dead-letter transitions, and delivery receipts.
  - `runtime/relay-service.ts` for outbound relay and signed delivery-receipt callbacks.
  - `runtime/server.ts` for HTTP route handling (`/v1/status`, dead-letter ops, `/v1/outbound`).
  - `runtime/trusted-receipts.ts`, `runtime/url.ts`, `runtime/ws.ts`, and `runtime/parse.ts` for focused helper concerns.
- Keep canonical OpenClaw hook payload shaping in `openclaw-payload.ts` so runtime and client delivery paths do not drift.
- Keep `inbound-inbox.ts` as the public API surface (`ConnectorInboundInbox`, factory helpers, exported types) and route internals through `inbound-inbox/` modules:
  - `inbound-inbox/types.ts` for inbox/dead-letter/event contracts.
  - `inbound-inbox/parse.ts` for shared string sanitization helpers.
  - `inbound-inbox/records.ts` for SQLite row mapping and payload serialization.
  - `inbound-inbox/storage.ts` for SQLite schema, queries, transactions, and event pruning.

- DID checks in frame/runtime paths must be DID v2 only: accept `did:cdi:<authority>:<agent|human>:<ulid>` via protocol parsers (`parseDid` / `parseAgentDid`) and never use string-prefix checks.
- Keep websocket lifecycle + ack behavior in `client.ts`.
- Keep local runtime orchestration (`/v1/outbound`, `/v1/status`, auth refresh, replay loop) in `runtime.ts`.
- Keep durable inbound storage logic isolated in `inbound-inbox.ts`.

## Inbound Durability Rules
- Connector must persist inbound relay payloads before sending `deliver_ack accepted=true`.
- Persist connector inbox state in `agents/<agent>/inbound-inbox/inbox.sqlite3` and treat that SQLite database as the only source of truth.
- Enable WAL mode and keep every mutating inbox path transactional so pending, dead-letter, and event rows stay consistent on failure.
- Inbox dedupe key is request/frame id; duplicates must not create extra pending entries.
- Replay must continue after runtime restarts by loading pending entries from SQLite at startup.
- Do not drop pending entries on transient replay failures; reschedule with bounded backoff.
- Non-retryable replay failures must move to dead-letter after `CONNECTOR_INBOUND_DEAD_LETTER_NON_RETRYABLE_MAX_ATTEMPTS`.
- Dead-letter operations (`listDeadLetter`, `replayDeadLetter`, `purgeDeadLetter`) must update bytes/count accounting atomically with the same transaction that moves rows.
- Keep event retention bounded via `eventsMaxRows`; do not reintroduce byte/file rotation logic.
- Preserve inbound `conversationId`, `replyTo`, and `groupId` metadata through inbox persistence and replay delivery.
- Ignore stale JSON inbox files if they still exist on disk; do not read, migrate, or delete them inside the runtime.

## Replay/Health Rules
- Keep replay configuration environment-driven via `CONNECTOR_INBOUND_*` vars with safe defaults from `constants.ts`.
- Keep OpenClaw liveness probing environment-driven via `CONNECTOR_OPENCLAW_PROBE_INTERVAL_MS` and `CONNECTOR_OPENCLAW_PROBE_TIMEOUT_MS`; replay should skip direct hook delivery while probe state is down.
- Runtime registry refresh target must be derived from decoded AIT `iss` claims, not required as explicit runtime input.
- Keep runtime replay retry bounds environment-driven via `CONNECTOR_RUNTIME_REPLAY_*`; only retry retryable OpenClaw hook failures.
- Keep OpenClaw hook-token precedence deterministic: explicit connector token input (`--openclaw-hook-token` / `OPENCLAW_HOOK_TOKEN`) must override `openclaw-relay.json`, and runtime disk sync applies only when explicit token input is absent.
- `/v1/status` must use the nested contract:
  - `websocket.{connected,connectAttempts,reconnectCount,uptimeMs,lastConnectedAt}`
  - `inbound.pending`
  - `inbound.deadLetter`
  - `inbound.replay`
  - `inbound.openclawGateway`
  - `inbound.openclawHook`
  - `metrics.{heartbeat,inboundDelivery,outboundQueue}`
- On inbox/status read failures, return explicit structured errors instead of crashing runtime.
- Keep connector runtime/inbox timestamps standardized via shared SDK datetime helpers (`nowUtcMs`, `toIso`, `nowIso`) instead of ad-hoc datetime formatting.
- Keep dead-letter operational endpoints stable:
  - `GET /v1/inbound/dead-letter`
  - `POST /v1/inbound/dead-letter/replay`
  - `POST /v1/inbound/dead-letter/purge`
- For dead-letter replay/purge targeting, treat omitted `requestIds` as "all", but treat `requestIds: []` (or empty after sanitization) as a no-op.
- For replay delivery callbacks, post signed receipts directly to the validated `replyTo` target (`/v1/relay/delivery-receipts`) and enforce trusted origin checks before sending.
- Receipt frame status values remain `processed_by_openclaw` and `dead_lettered`; do not widen status enums without coordinated proxy/runtime changes.

## WebSocket Resilience Rules
- Keep websocket reconnect behavior centralized in `client.ts` (single cleanup path for close/error/unexpected-response/timeout).
- Keep default websocket connect timeout at `DEFAULT_CONNECT_TIMEOUT_MS` (15000ms) and heartbeat ack timeout at `DEFAULT_HEARTBEAT_ACK_TIMEOUT_MS` (60000ms).
- Track outbound heartbeat IDs and clear pending entries only when matching `heartbeat_ack` frames are received.
- If heartbeat ack timeout expires, disconnect and reconnect using the same reconnect policy used for other transport failures.
- Handle `unexpected-response` status codes from ws upgrade failures; for `401`, trigger `onAuthUpgradeRejected` and allow one immediate reconnect before normal backoff.
- Keep outbound enqueue buffering durable when configured via `outboundQueuePersistence`; load once before replaying queued frames and persist on enqueue/dequeue transitions.
- Keep websocket/client metrics in `ConnectorClient` (`getMetricsSnapshot`) so runtime health does not recompute transport stats ad hoc.
- Keep local OpenClaw hook auth rejection (`401/403`) retryable in connector delivery paths so token rotation windows do not permanently fail deliveries.
- Keep structured identity headers on connector hook delivery requests in both runtime replay and direct client-delivery modes:
  - required: `x-clawdentity-agent-did`, `x-clawdentity-to-agent-did`, `x-clawdentity-verified`
  - optional sender profile: `x-clawdentity-agent-name`, `x-clawdentity-display-name` (omit when unknown)
  - optional group context: `x-clawdentity-group-id` when present on inbound frames
- `/hooks/wake` payload builders must preserve inbound `sessionId` when present.
- Keep runtime stop behavior fail-fast by aborting in-flight local OpenClaw hook requests via shared runtime shutdown signals.

## Testing Rules
- `inbound-inbox.test.ts` must cover SQLite persistence, dedupe, cap enforcement, replay bookkeeping, dead-letter thresholding, dead-letter replay, dead-letter purge, event pruning, corrupt-db recovery, and transaction rollback.
- Runtime sandbox test helpers must clean temporary directories with retry-aware recursive removal (`maxRetries`/`retryDelay`) to avoid ENOTEMPTY flake while receipt-outbox files are settling.
- `client.test/*.test.ts` must stay split by concern (for example delivery/heartbeat, reconnect lifecycle, outbound queue) to keep each test file focused and easy to maintain.
- Keep runtime integration tests split across focused `runtime.*.test.ts` files so no single source file exceeds repository file-size guardrails.
- `client.test/*.test.ts` must cover both delivery modes:
  - direct local OpenClaw delivery fallback
  - injected inbound persistence handler ack path
- `client.test/*.test.ts` must keep websocket lifecycle expectations compatible with non-persistent and persistent queue modes.
