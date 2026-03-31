# AGENTS.md (apps/openclaw-skill/skill/references)

## Purpose
- Keep the modular OpenClaw reference docs aligned with the current runtime contracts.

## Rules
- Document pair payload fields and projected relay snapshot fields separately.
- Pairing examples must keep `humanName` where the pair API still uses it.
- Projected relay snapshot examples must use `displayName` and may include additive metadata such as `framework`, `description`, and `lastSyncedAtMs`.
- When documenting group headers, distinguish proxy routing headers from OpenClaw-facing inbound metadata headers.
- Outbound relay examples must use the current connector request contract:
  - direct routing uses `toAgentDid`
  - group routing uses `groupId`
  - never resurrect legacy `peerDid` / `peerProxyUrl` request bodies in connector examples
- Keep `/hooks/wake` and `/hooks/agent` delivery contracts documented separately. Wake is text-first; agent is structured JSON.
- Use `group join token` as the canonical term.
- Protocol receive docs must describe `senderAgentName`, `senderDisplayName`, and `groupName` as expected runtime metadata sourced from trusted local/registry resolution, with IDs as fallback identity.
- Protocol send docs must keep canonical routing language (`payload.peer` for direct, `payload.groupId` for groups, mutually exclusive in one request).
