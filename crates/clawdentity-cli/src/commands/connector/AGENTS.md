# AGENTS.md (crates/clawdentity-cli/src/commands/connector)

## Purpose
- Keep connector runtime helpers split by concern so structural rules stay green.

## Rules
- Put inbound relay delivery, retry persistence, and OpenClaw hook payload shaping in focused helper modules instead of growing `connector.rs`.
- If inbound delivery is persisted for local retry, ACK the relay as accepted so the retry path stays single-source.
- Wake payloads must only include `sessionId` when the inbound payload explicitly carries one.
- `/hooks/wake` remains the visible default for peer delivery; `/hooks/agent` is only for explicit isolated-hook routing.
- Inject `agentId` into OpenClaw payloads only when delivering to `/hooks/agent` and a non-empty mapped `openclawAgentId` exists for the active Clawdentity agent.
- Keep `/hooks/agent` routing symmetric for deliveries and receipts: when a mapped `openclawAgentId` exists, both payload types must include `agentId`.
- Never inject `agentId` for `/hooks/wake`; wake-mode payload shape must stay stable for backward compatibility and visible chat delivery.
- Runtime config resolution for OpenClaw routing must read per-agent `openclawAgentId` from connector assignment state and gracefully return `None` when mapping data is absent.
- Connector startup must enforce `CLAWDENTITY_EXPECTED_AGENT_NAME` when present and fail fast on mismatched agent selection; this prevents cross-container identity inversion in local dual-agent harnesses.
- Connector runtime tests must cover expected-agent-name bypass behavior (`None`/blank expected value) in addition to match/mismatch failures so env-unset paths remain intentional and stable.
- Keep connector test files under structural limits by grouping focused cases into submodules (for example `tests/expected_agent_name.rs`) instead of growing a single monolithic `tests.rs`.
- Keep hook payload builders split into focused helpers so the structural 50-line non-test function rule stays green.
- Inbound OpenClaw hook requests must keep canonical identity headers (`x-clawdentity-agent-did`, `x-clawdentity-to-agent-did`, `x-clawdentity-verified`, `x-request-id`) and only add sender profile headers (`x-clawdentity-agent-name`, `x-clawdentity-human-name`) when local peer metadata exists.
- Keep sender-profile DID lookup and header shaping in focused helpers/modules instead of expanding `delivery.rs`.
- Keep OpenClaw payload/summary shaping in `delivery/openclaw_payload.rs`; `delivery.rs` should orchestrate delivery flow and persistence, not own long JSON/text render helpers.
- Keep inbound delivery orchestration dependencies grouped in a small runtime context struct when passing through async helpers, so Clippy `too_many_arguments` stays green without using allow-attributes.
- Handle pairing acceptance system events in `delivery/pair_accepted.rs` and invoke that processor in both live inbound delivery flow and retry replay flow.
- Keep pair-accepted peer persistence idempotent by reusing core helper `persist_confirmed_peer_from_profile_and_proxy_origin`; never duplicate direct peer upsert/snapshot logic in connector runtime.
- Pair-accepted system side effects must run only for trusted relay delivery provenance (`deliverySource=proxy.events.queue.pair_accepted`); never mutate peer state for user-authored payload-only `system.type=pair.accepted`.
- Pair-accepted system payload validation must include DID checks, responder proxy origin URL checks, and event timestamp parsing before mutating peer state.
- Pair-accepted structured fields are mandatory for trusted side effects; optional `system.message` is UX-only and must never be used as a replacement for persistence/trust metadata.
- For OpenClaw-facing notifications, prefer proxy-provided non-empty `system.message` when present and fall back to local generated message text when absent.
- Keep proxy receipt dispatch + durable outbox behavior in `receipts.rs`; do not re-embed receipt persistence/retry logic into `connector.rs` or `delivery.rs`.
- Keep receipt outbox mutations in a single-writer command flow (enqueue/flush serialized) so disk-backed retries remain race-safe under concurrent runtime tasks.
- Persist receipt outbox updates with atomic write-then-rename (`*.tmp-*` -> final path) so crashes cannot leave partially written JSON that drops queued receipts.
- Receipt callback routing authority is always the runtime-owned local proxy receipt URL; do not trust inbound `reply_to` for callback destination selection.
- Receipt PoP nonces must be cryptographically random, URL-safe, and one-time per request signing call; never derive them from timestamps/counters.
- Keep receipt payload tests asserting status parity at top-level and metadata level so `dead_lettered` and `processed_by_openclaw` stay externally consistent for OpenClaw hooks.
