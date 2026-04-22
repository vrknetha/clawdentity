# AGENTS.md (crates/clawdentity-core/src/pairing)

## Purpose
- Keep pairing contracts stable for CLI, proxy, and connector flows.

## Rules
- Optional JSON fields must be omitted when absent; do not serialize nullable protocol fields when the API contract expects omission.
- Preserve peer metadata (`agentName`, `humanName`, `proxyUrl`) end to end.
- Keep peer persistence centralized in `persist_confirmed_peer_from_profile_and_proxy_origin`; pairing commands and connector runtime event handlers must share this helper.
- Keep shared peer persistence strict about proxy URL source: resolve with explicit precedence `explicit peer proxy origin -> profile proxy origin`; issuer fallback belongs only to pairing-ticket command flows that derive issuer origin explicitly.
- Add regression tests for request-shape changes before shipping pairing updates.
