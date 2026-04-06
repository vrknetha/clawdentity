# AGENTS.md (apps/proxy/src/queue-consumer)

## Purpose
- Keep queue-consumer event parsing and routing deterministic, strict, and easy to audit.

## Rules
- Parse queue payloads with explicit field validation; reject malformed messages early so retries/DLQ behavior is intentional.
- Keep each event handler focused by event type and route only supported events; add dedicated handlers before subscribing this worker to new queue event families.
- Route `delivery_receipt` events to the sender relay Durable Object using typed RPC helpers (`recordRelayDeliveryReceipt`) rather than ad-hoc `fetch` payload strings.
- Route `agent.auth.revoked` events to proxy trust-state via typed trust-store methods (`markAgentRevoked`) rather than bespoke DO endpoint strings.
- Route `pair.accepted` events to the initiator relay Durable Object using typed relay RPC helpers (`deliverToRelaySession`) with system payload wrapping.
- Route `group.member.joined` events to recipient relay Durable Objects using typed relay RPC helpers (`deliverToRelaySession`) and user-readable notification payloads.
- Preserve optional `pair.accepted.message` during routing so initiator UX can show proxy-authored static notifications.
- Treat blank optional `pair.accepted.message` as ignorable UX metadata; do not let cosmetic message issues block trusted relay routing.
- Queue-routed `pair.accepted` relay deliveries must set trusted delivery provenance (`deliverySource=proxy.events.queue.pair_accepted`) so connector runtimes can reject spoofed payload-only system events.
- Queue-routed `pair.accepted` system payloads must include `responderProfile.displayName` for connector-side trusted parsing; keep `responderProfile.humanName` mirrored for backward compatibility during rollout.
- Queue-routed `group.member.joined` relay deliveries must set trusted delivery provenance (`deliverySource=proxy.events.queue.group_member_joined`) so notification origin stays auditable.
- Pair-accepted structured fields remain mandatory for trusted side effects; queue consumers must not treat `message` as a replacement for those fields.
- Treat queue events as at-least-once: handlers must be idempotent against duplicate messages.
- Keep the `delivery_receipt` queue contract minimal (sender/recipient/request/status/reason/timestamp) and avoid carrying callback-origin metadata that is not consumed by handlers.
- Keep registry revocation queue handling strict: only hard revokes (`data.reason=agent_revoked`) with valid `data.metadata.agentDid` may mutate trust state.
- Parse and normalize revoked `agentDid` once per queue message, then pass the normalized value through handler layers without re-validating it in the same flow.
- Keep queue acknowledgment policy explicit: unsupported/invalid events are `ack` + warn; reserve `retry` for transient delivery or trust-state dependency failures only.
- Missing queue bindings (for example `PROXY_TRUST_STATE` for `agent.auth.revoked` or `AGENT_RELAY_SESSION` for relay-routed events) must be handled as explicit non-retryable `ack` failures with a dedicated reason code, not through generic retry fallback.
