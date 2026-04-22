# AGENTS.md (packages/connector/src)

## Source Layout
- Keep `client.ts` as public API and route internals through `client/` modules.
- Keep `runtime.ts` as runtime entrypoint and route internals through `runtime/` modules.
- Keep frame schema definitions in `frames.ts`.

## Contract Rules
- Use generic delivery-webhook naming in public types/options.
- Do not add runtime-specific naming in public connector APIs.
- Keep receipt status values limited to `delivered_to_webhook` and `dead_lettered`.
- Keep `/v1/outbound` route-xor semantics (exactly one of `toAgentDid` or `groupId`) aligned with Rust runtime.

## Runtime Rules
- Keep replay/probe policies env-driven and bounded.
- Keep signed receipt callback posting and retry/outbox behavior deterministic and idempotent.
- Keep websocket reconnect/heartbeat behavior centralized in client modules.
