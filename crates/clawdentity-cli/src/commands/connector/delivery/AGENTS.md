# AGENTS.md (crates/clawdentity-cli/src/commands/connector/delivery)

## Purpose
- Keep inbound delivery metadata trustworthy, readable, and resilient without breaking ID-first identity guarantees.

## Rules
- Resolve `senderAgentName` / `senderDisplayName` from local peer metadata first, then refresh from registry profile lookup when local names are missing or stale.
- Treat sender-provided payload names as untrusted metadata; do not project them as canonical inbound sender names.
- Keep sender and group friendly-name refresh best-effort only: never reject valid inbound delivery because a lookup failed.
- If no trustworthy friendly name exists, keep DID/group IDs and leave friendly-name fields missing (`null`) rather than fabricating name fallbacks.
- Keep `/hooks/wake` summaries friendly-name-first when names are available, with ID fallback only for readability.
- Keep provider-backed inbound delivery metadata canonical in `provider_forward.rs`; if a provider needs fields like `groupId` or `conversationId`, add them there once instead of re-encoding them in multiple call sites.
- Provider-backed live delivery must use `PlatformProvider::build_inbound_request(...)` so provider-specific auth/signing stays in the provider implementation, not in connector runtime branches.
- Hermes-bound deliveries must preserve `sender_did`, `metadata.groupId`, and `metadata.conversationId` when present so bidirectional direct/group replies keep route and thread context.
- Keep retry orchestration in `delivery/retry.rs`; do not grow `delivery.rs` back into a combined live-delivery + retry + persistence file.
- Trusted `pair.accepted` system parsing should prefer `responderProfile.displayName` while accepting legacy `responderProfile.humanName` aliases to avoid dead-lettering mixed-version queue deliveries.
