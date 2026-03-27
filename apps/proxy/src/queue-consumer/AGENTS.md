# AGENTS.md (apps/proxy/src/queue-consumer)

## Purpose
- Keep queue-consumer event parsing and routing deterministic, strict, and easy to audit.

## Rules
- Parse queue payloads with explicit field validation; reject malformed messages early so retries/DLQ behavior is intentional.
- Keep each event handler focused by event type (`delivery_receipt`, `agent.auth.*`) and avoid mixing multiple workflows in one function.
- Route `delivery_receipt` events to the sender relay Durable Object using typed RPC helpers (`recordRelayDeliveryReceipt`) rather than ad-hoc `fetch` payload strings.
- Treat queue events as at-least-once: handlers must be idempotent against duplicate messages.
- Keep the `delivery_receipt` queue contract minimal (sender/recipient/request/status/reason/timestamp) and avoid carrying callback-origin metadata that is not consumed by handlers.
