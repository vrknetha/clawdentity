# AGENTS.md (packages/connector)

## Purpose
- Provide a runtime-portable connector client for WebSocket relay integration and local OpenClaw delivery.

## Design Rules
- Keep frame contracts in `src/frames.ts` as the single schema authority.
- Validate all inbound and outbound frames through zod schemas; do not bypass parser helpers.
- Reuse shared protocol validators (`parseDid`, `parseUlid`) instead of duplicating DID/ULID logic.
- Keep reconnect and heartbeat behavior deterministic and testable via dependency injection (`webSocketFactory`, `fetchImpl`, clock/random).
- Keep local OpenClaw delivery concerns in `src/client.ts`; do not spread HTTP delivery logic across modules.
- Keep local OpenClaw restart handling bounded: retry only transient delivery failures with capped backoff and an overall retry budget so connector ack behavior remains compatible with relay DO delivery timeouts.
- Refresh agent access credentials at runtime startup when cached access tokens are missing or near expiry before attempting relay WebSocket connection, while persisting refreshed auth atomically to `registry-auth.json`.

## Testing Rules
- `src/frames.test.ts` must cover roundtrip serialization and explicit invalid-frame failures.
- Client tests must mock WebSocket/fetch and verify heartbeat ack, delivery forwarding, reconnect, and outbound queue flush behavior.
- Keep tests fully offline and deterministic (fake timers where timing matters).
