# AGENTS.md (packages/connector/src/client)

## Purpose
- Keep `ConnectorClient` internals modular, testable, and deterministic.

## Rules
- Keep `client.ts` as orchestration for public API methods (`connect`, `disconnect`, `enqueueOutbound`) and high-level flow only.
- Keep reconnect timer/attempt scheduling logic in `reconnect-scheduler.ts`.
- Keep websocket listener registration wiring in `socket-events.ts`.
- Keep socket lifecycle event-callback composition in `socket-session.ts`.
- Keep frame/event parsing and sanitization in `helpers.ts` as pure functions.
- Keep inbound frame parsing + frame-type dispatch in `inbound.ts` so `client.ts` only wires handlers.
- Keep inbound dispatch wiring in `inbound-router.ts` so heartbeat ack + deliver routing stay out of `client.ts`.
- Keep connector transport/inbound delivery metrics state in `metrics.ts` to avoid duplicating counters in `client.ts`.
- Keep reconnect delay math in `retry.ts` and avoid inline backoff duplication.
- Keep heartbeat tracking and metrics centralized in `heartbeat.ts`.
- Keep outbound queue persistence and load/flush semantics centralized in `queue.ts`.
- Keep outbound send/flush orchestration helpers in `outbound-flush.ts`.
- Keep local OpenClaw delivery/retry behavior in `delivery.ts` and inbound ack orchestration in `inbound-delivery.ts`.
- Design additional helper modules with narrow interfaces:
  - `lifecycle.ts` should orchestrate `connect`/`disconnect`, queue hydration, heartbeat lifecycle, and hook invocation while exposing start/stop/attached-state APIs invoked by `ConnectorClient`.
  - `socket-events.ts` should register WebSocket listeners (`open`, `message`, `close`, `error`, `unexpected-response`) via dependency-injected callbacks (logger, hooks, heartbeat manager, reconnect scheduler) so event handling remains testable.
  - `reconnect.ts` should own reconnection timers/backoff (`schedule`, `clear`) using injected timing/random utilities plus a pluggable callback instead of inline timeout tracking inside `client.ts`.
  - Each helper module must accept only the dependencies it truly needs (e.g., logger, metrics tracker, heartbeat/reconnect interfaces, hooks) so wiring in `ConnectorClient` stays declarative and easy to mock.

## SRP guidance
- When refactoring `client.ts`, keep `ConnectorClient` as the stable public surface while slicing out targeted helpers that do one thing well (lifecycle, socket session, delivery, routing, metrics).  Document the new helper in this AGENTS.md so others know what each file owns.
- Potential helper candidates to extract along this path:
  - `lifecycle.ts` (start/stop state, queue hydration, heartbeat lifecycle, reconnect scheduling + hook invocation).
  - `socket-session.ts` (WebSocket dial/close/send, connect timeout, attach/detach guard, injected event callbacks for open/message/close/error/unexpected-response, metrics hooks).
  - `outbound-flush.ts` (queue flush orchestration and serialization assistance so `ConnectorClient` no longer reaches directly into `queue.ts`).
  - `inbound-router.ts` (handles raw message parsing, routes heartbeat/deliver frames to heartbeat manager/handlers, and records metrics before handing off to `handleInboundDeliverFrame`).
- `delivery.ts` and `inbound-delivery.ts` stay responsible for OpenClaw delivery + ack orchestration and should expose injectable hooks for testing retries/timeout logic.
- `delivery.ts` may resolve optional sender profile metadata via injected resolver callbacks, but delivery must stay best-effort: lookup failures cannot block ACK flow.
- When sender profile is unavailable, omit `x-clawdentity-agent-name` and `x-clawdentity-human-name` instead of sending empty placeholders.
