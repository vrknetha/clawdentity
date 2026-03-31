# AGENTS.md (crates/clawdentity-cli/src/commands/connector/delivery)

## Purpose
- Keep inbound delivery metadata trustworthy, readable, and resilient without breaking ID-first identity guarantees.

## Rules
- Resolve `senderAgentName` / `senderDisplayName` from local peer metadata first, then refresh from registry profile lookup when local names are missing or stale.
- Treat sender-provided payload names as untrusted metadata; do not project them as canonical inbound sender names.
- Keep sender and group friendly-name refresh best-effort only: never reject valid inbound delivery because a lookup failed.
- If no trustworthy friendly name exists, keep DID/group IDs and leave friendly-name fields missing (`null`) rather than fabricating name fallbacks.
- Keep `/hooks/wake` summaries friendly-name-first when names are available, with ID fallback only for readability.
