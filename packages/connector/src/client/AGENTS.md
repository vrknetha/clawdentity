# AGENTS.md (packages/connector/src/client)

## Purpose
- Keep `ConnectorClient` internals modular, testable, and deterministic.

## Rules
- Keep frame/event parsing and sanitization in `helpers.ts` as pure functions.
- Keep inbound frame parsing + frame-type dispatch in `inbound.ts` so `client.ts` only wires handlers.
- Keep connector transport/inbound delivery metrics state in `metrics.ts` to avoid duplicating counters in `client.ts`.
- Keep reconnect delay math in `retry.ts` and avoid inline backoff duplication.
- Keep heartbeat tracking and metrics centralized in `heartbeat.ts`.
- Keep outbound queue persistence and load/flush semantics centralized in `queue.ts`.
- Keep local OpenClaw delivery/retry behavior in `delivery.ts` and inbound ack orchestration in `inbound-delivery.ts`.
