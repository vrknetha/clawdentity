# AGENTS.md (crates/clawdentity-core/src/pairing)

## Purpose
- Keep pairing contracts stable for CLI, proxy, and provider flows.

## Rules
- Optional JSON fields must be omitted when absent; do not serialize nullable protocol fields when the API contract expects omission.
- Preserve peer metadata (`agentName`, `humanName`, `proxyUrl`) end to end.
- Add regression tests for request-shape changes before shipping pairing updates.
