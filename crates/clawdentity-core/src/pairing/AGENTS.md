# AGENTS.md (crates/clawdentity-core/src/pairing)

## Purpose
- Keep pairing contracts stable for CLI, proxy, and provider flows.

## Rules
- Optional JSON fields must be omitted when absent; do not serialize nullable protocol fields when the API contract expects omission.
- Preserve peer metadata (`agentName`, `humanName`, `proxyUrl`) end to end.
- Keep peer persistence centralized in `persist_confirmed_peer_from_profile_and_proxy_origin`; pairing commands and connector runtime event handlers must share this helper.
- Resolve peer proxy URL with explicit precedence: explicit peer proxy origin -> profile proxy origin -> issuer proxy origin.
- Add regression tests for request-shape changes before shipping pairing updates.
