# AGENTS.md (crates/clawdentity-cli/src/commands/connector)

## Purpose
- Keep connector runtime helpers split by concern and aligned to the generic relay contract.

## Rules
- Inbound delivery payload contract is canonical:
  - `Content-Type: application/vnd.clawdentity.delivery+json`
  - body `type: "clawdentity.delivery.v1"`
- Preserve these fields in webhook payloads: `requestId`, `fromAgentDid`, `toAgentDid`, `payload`, optional `conversationId`, optional `groupId`, sender display fields, relay metadata.
- Receipt status values are constrained to `delivered_to_webhook` and `dead_lettered`.
- If inbound delivery is persisted for local retry, ACK relay as accepted so retry ownership is single-source.
- Keep sender-profile/group-name resolution best-effort; failures must not block valid relay delivery.
- Keep runtime config per agent under Clawdentity state (`agents/<agent>/delivery-webhook.json`).
- Keep delivery header parsing strict (`Name: value`) and reject malformed header entries.
- Apply fixed delivery headers directly in hot send paths; avoid rebuilding static header-name strings per message.
