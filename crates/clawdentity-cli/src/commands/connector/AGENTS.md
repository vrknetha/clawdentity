# AGENTS.md (crates/clawdentity-cli/src/commands/connector)

## Purpose
- Keep connector runtime helpers split by concern so structural rules stay green.

## Rules
- Put inbound relay delivery, retry persistence, and OpenClaw hook payload shaping in focused helper modules instead of growing `connector.rs`.
- If inbound delivery is persisted for local retry, ACK the relay as accepted so the retry path stays single-source.
- Wake payloads must only include `sessionId` when the inbound payload explicitly carries one.
- `/hooks/wake` remains the visible default for peer delivery; `/hooks/agent` is only for explicit isolated-hook routing.
- Keep hook payload builders split into focused helpers so the structural 50-line non-test function rule stays green.
- Inbound OpenClaw hook requests must keep canonical identity headers (`x-clawdentity-agent-did`, `x-clawdentity-to-agent-did`, `x-clawdentity-verified`, `x-request-id`) and only add sender profile headers (`x-clawdentity-agent-name`, `x-clawdentity-human-name`) when local peer metadata exists.
- Keep sender-profile DID lookup and header shaping in focused helpers/modules instead of expanding `delivery.rs`.
- Keep proxy receipt dispatch + durable outbox behavior in `receipts.rs`; do not re-embed receipt persistence/retry logic into `connector.rs` or `delivery.rs`.
- Keep receipt outbox mutations in a single-writer command flow (enqueue/flush serialized) so disk-backed retries remain race-safe under concurrent runtime tasks.
- Receipt callback routing authority is always the runtime-owned local proxy receipt URL; do not trust inbound `reply_to` for callback destination selection.
- Receipt PoP nonces must be cryptographically random, URL-safe, and one-time per request signing call; never derive them from timestamps/counters.
- Keep receipt payload tests asserting status parity at top-level and metadata level so `dead_lettered` and `processed_by_openclaw` stay externally consistent for OpenClaw hooks.
