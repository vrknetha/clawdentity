# AGENTS.md (crates/clawdentity-core/src/runtime)

## Purpose
- Guard the embedded local runtime HTTP/WebSocket surfaces used by connector mode.

## Rules
- Runtime `/v1/outbound` request contract is canonical `toAgentDid + payload` (optional `conversationId`, `replyTo`); do not maintain legacy `peerDid` / `peerProxyUrl` acceptance paths.
- Keep outbound enqueue path durable-first: persist before relay send, then flush due frames using retry metadata and bounded exponential backoff.
- Keep outbound retry policy env-driven (`CONNECTOR_OUTBOUND_RETRY_*`, `CONNECTOR_OUTBOUND_MAX_AGE_MS`) with dead-letter on expiry/exhaustion.
- Keep public runtime functions documented with `///` comments so structural documentation gates stay green in CI.
- Enforce outbound queue backpressure via configurable max pending (`CONNECTOR_OUTBOUND_MAX_PENDING`) and return explicit `507` queue-full errors.
- Keep runtime state testable without process-global env mutation; use state-level queue-limit overrides in tests instead of shared `set_var/remove_var`.
- Keep status and dead-letter endpoints machine-readable and stable for doctor/relay-test automation.
- `/v1/status` outbound queue payload must include pending, retrying, dead-letter, oldest-age, and next-retry visibility for operator troubleshooting.
