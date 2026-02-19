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
- Refresh agent access credentials at runtime startup when cached access tokens are missing or near expiry before attempting relay WebSocket connection, while persisting refreshed auth atomically to `registry-auth.json`.
- Sync `registry-auth.json` from disk before runtime auth refresh/retry decisions so external `agent auth refresh` updates are picked up without requiring a connector restart.
- Accept base proxy websocket URLs (`ws://host:port` / `wss://host`) and normalize them to relay connect path (`/v1/relay/connect`) before connector dial; avoid requiring callers to know the relay path details.
- Regenerate relay WebSocket auth headers (timestamp/nonce/signature) on every reconnect attempt; never reuse a previously-signed header set across retries.

## Testing Rules
- `src/frames.test.ts` must cover roundtrip serialization and explicit invalid-frame failures.
- Client tests must mock WebSocket/fetch and verify heartbeat ack, delivery forwarding, reconnect, and outbound queue flush behavior.
- Inbox tests must cover persistence, dedupe by request id, cap enforcement, and replay state transitions (`markReplayFailure`/`markDelivered`).
- Keep tests fully offline and deterministic (fake timers where timing matters).
