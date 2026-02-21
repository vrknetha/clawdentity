# AGENTS.md (packages/connector)

## Purpose
- Provide a runtime-portable connector client for WebSocket relay integration and local OpenClaw delivery.

## Design Rules
- Keep frame contracts in `src/frames.ts` as the single schema authority.
- Validate all inbound and outbound frames through zod schemas; do not bypass parser helpers.
- Reuse shared protocol validators (`parseDid`, `parseUlid`) instead of duplicating DID/ULID logic.
- Keep reconnect and heartbeat behavior deterministic and testable via dependency injection (`webSocketFactory`, `fetchImpl`, clock/random).
- Keep local OpenClaw delivery concerns in `src/client.ts`; do not spread HTTP delivery logic across modules.
- Keep inbound connector delivery durable: acknowledge proxy delivery only after payload persistence to local inbox (`agents/<agent>/inbound-inbox/index.json`), then replay asynchronously to OpenClaw hook.
- Keep local inbox storage portable and inspectable (`index.json` + `events.jsonl`) with atomic index writes (`.tmp` + rename); do not introduce runtime-specific persistence dependencies for connector inbox state.
- Keep replay behavior restart-safe: on runtime boot, replay pending inbox entries in background before relying on new WebSocket traffic.
- Keep local OpenClaw replay backoff bounded and deterministic (`CONNECTOR_INBOUND_RETRY_*` / `CONNECTOR_INBOUND_REPLAY_*`) with structured logging for replay success/failure.
- Keep local OpenClaw replay delivery liveness-aware: probe `OPENCLAW_BASE_URL` on a fixed interval (`CONNECTOR_OPENCLAW_PROBE_INTERVAL_MS` / `CONNECTOR_OPENCLAW_PROBE_TIMEOUT_MS`) and skip replay delivery attempts while the gateway is known down.
- Keep runtime replay delivery retries explicit and bounded (`CONNECTOR_RUNTIME_REPLAY_*`) and apply retries only for retryable OpenClaw errors.
- Refresh agent access credentials at runtime startup when cached access tokens are missing or near expiry before attempting relay WebSocket connection, while persisting refreshed auth atomically to `registry-auth.json`.
- Sync `registry-auth.json` from disk before runtime auth refresh/retry decisions so external `agent auth refresh` updates are picked up without requiring a connector restart.
- Accept base proxy websocket URLs (`ws://host:port` / `wss://host`) and normalize them to relay connect path (`/v1/relay/connect`) before connector dial; avoid requiring callers to know the relay path details.
- Regenerate relay WebSocket auth headers (timestamp/nonce/signature) on every reconnect attempt; never reuse a previously-signed header set across retries.
- Keep OpenClaw hook token rotation resilient: re-read `openclaw-relay.json` before replay batches and treat OpenClaw hook `401/403` as retryable auth-rejection signals that trigger token refresh + retry.
- Keep connector-to-OpenClaw metadata explicit by forwarding structured identity headers (`x-clawdentity-agent-did`, `x-clawdentity-to-agent-did`, `x-clawdentity-verified`) alongside the payload.
- Keep connector shutdown fast and deterministic: abort in-flight OpenClaw hook requests on runtime stop instead of waiting for full request timeout.

## Testing Rules
- `src/frames.test.ts` must cover roundtrip serialization and explicit invalid-frame failures.
- Client tests must mock WebSocket/fetch and verify heartbeat ack, delivery forwarding, reconnect, and outbound queue flush behavior.
- Inbox tests must cover persistence, dedupe by request id, cap enforcement, and replay state transitions (`markReplayFailure`/`markDelivered`).
- Keep tests fully offline and deterministic (fake timers where timing matters).

## Modularization Notes
- Treat `ConnectorClient` as the orchestration entry point; extract lifecycle, socket event handling, and reconnect scheduling into explicit helper modules so the public API stays stable while internals become easier to unit test.
- New helper modules should expose narrow interfaces (start/stop, attach/detach, schedule/clear) and accept injected dependencies like `Logger`, heartbeat/metric helpers, and hooks so they are replaceable during testing.
- Document any new helper modules in the respective `client/AGENTS.md` so future contributors can quickly see the division of responsibilities.
