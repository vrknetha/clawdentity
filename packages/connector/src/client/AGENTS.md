# AGENTS.md (packages/connector/src/client)

## Purpose
- Keep `ConnectorClient` internals modular, testable, and deterministic.

## Rules
- Keep frame/event parsing and sanitization in `helpers.ts` as pure functions.
- Keep reconnect delay math in `retry.ts` and avoid inline backoff duplication.
- Keep heartbeat tracking and metrics centralized in `heartbeat.ts`.
- Keep outbound queue persistence and load/flush semantics centralized in `queue.ts`.
- Keep local OpenClaw delivery/retry behavior in `delivery.ts` and inbound ack orchestration in `inbound-delivery.ts`.
