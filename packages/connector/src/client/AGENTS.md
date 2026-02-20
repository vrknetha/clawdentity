# AGENTS.md (packages/connector/src/client)

## Purpose
- Keep `ConnectorClient` internals modular, testable, and deterministic.

## Rules
- Keep `client.ts` as orchestration for public API methods (`connect`, `disconnect`, `enqueueOutbound`) and high-level flow only.
- Keep reconnect timer/attempt scheduling logic in `reconnect-scheduler.ts`.
- Keep websocket listener registration wiring in `socket-events.ts`.
- Keep frame/event parsing and sanitization in `helpers.ts` as pure functions.
- Keep inbound frame parsing + frame-type dispatch in `inbound.ts` so `client.ts` only wires handlers.
- Keep connector transport/inbound delivery metrics state in `metrics.ts` to avoid duplicating counters in `client.ts`.
- Keep reconnect delay math in `retry.ts` and avoid inline backoff duplication.
- Keep heartbeat tracking and metrics centralized in `heartbeat.ts`.
- Keep outbound queue persistence and load/flush semantics centralized in `queue.ts`.
- Keep local OpenClaw delivery/retry behavior in `delivery.ts` and inbound ack orchestration in `inbound-delivery.ts`.
- Design additional helper modules with narrow interfaces:
  - `lifecycle.ts` should orchestrate `connect`/`disconnect`, queue hydration, heartbeat lifecycle, and hook invocation while exposing start/stop/attached-state APIs invoked by `ConnectorClient`.
  - `socket-events.ts` should register WebSocket listeners (`open`, `message`, `close`, `error`, `unexpected-response`) via dependency-injected callbacks (logger, hooks, heartbeat manager, reconnect scheduler) so event handling remains testable.
  - `reconnect.ts` should own reconnection timers/backoff (`schedule`, `clear`) using injected timing/random utilities plus a pluggable callback instead of inline timeout tracking inside `client.ts`.
  - Each helper module must accept only the dependencies it truly needs (e.g., logger, metrics tracker, heartbeat/reconnect interfaces, hooks) so wiring in `ConnectorClient` stays declarative and easy to mock.
