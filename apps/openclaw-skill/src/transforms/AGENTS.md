# AGENTS.md (apps/openclaw-skill/src/transforms)

## Purpose
- Guard transform-source behavior for relay handoff, peer snapshot loading, and OpenClaw-local runtime metadata.

## Rules
- Keep runtime-config path handling deterministic: explicit absolute paths win, relative paths stay relative to `hooks/transforms/`.
- Keep connector endpoint candidates stable: exact override first, container-safe fallbacks after it.
- Do not bypass `peers-config.ts` for peer alias loading or validation.
- Keep transform logic free of direct registry/proxy calls; local connector handoff is the only outbound path here.
- The `send-to-peer` OpenClaw mapping is a `wake`-action side-effect hook: keep transform input compatible with raw `ctx.payload`, and do not assume `agent` mappings still execute null-return relay transforms safely.
- Default relay `conversationId` must stay deterministic per local-agent/peer-agent pair using only stable DIDs from projected runtime metadata plus peer DID; treat top-level `payload.conversationId` as an intentional override, not as an always-present local chat ID.
- `clawdentity-relay.json` is the runtime source of truth for projected `localAgentDid`; do not default transform runtime behavior to host `HOME` probing.
- Missing or invalid projected `localAgentDid` is a setup/runtime error, not a reason to invent an alias-based relay lane.
- Keep relay envelope semantics explicit: send `conversationId` as a top-level `/v1/outbound` field and strip only `peer` from the forwarded application payload.
- Perform connector preflight health checks (`/v1/status`) before `/v1/outbound` handoff and keep probe timeout/cache TTL configurable for fast local-runtime failure signals.
- All connector HTTP calls must run with explicit timeouts; never allow unbounded fetch waits in relay transforms.
- Emit structured connector failure categories (`connector_unavailable`, `connector_timeout`, `connector_queue_full`, `connector_request_rejected`, `connector_request_failed`) with retry hints for OpenClaw-facing handling.
- Keep outbound connector envelope canonical (`toAgentDid`, `payload`, optional `conversationId`); do not reintroduce legacy relay fields (`peerDid`, `peerProxyUrl`).
- Keep connector health cache bounded and self-pruning (TTL + max entries); never allow unbounded per-endpoint growth in long-running transform hosts.
- Do not mark endpoint health as down for request-level rejections (`4xx` payload/contract errors); reserve unhealthy marks for timeout/connectivity failures.

## Testing
- Cover both default runtime metadata and explicit override behavior in transform tests.
- Cover relay `conversationId` behavior in transform tests: derived default, explicit override, missing-runtime-metadata failure, and request-body contract to the connector.
- Keep tests filesystem-isolated with temp directories or mocks; never depend on a real OpenClaw home.
