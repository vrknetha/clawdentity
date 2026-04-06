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
- Keep provider-aware connector wording explicit in reference docs:
  - OpenClaw hook-routing guidance applies only to OpenClaw
  - non-OpenClaw providers such as Hermes use provider runtime state saved by `provider setup`
  - `--openclaw-*` connector flags are OpenClaw-only manual overrides
- Use `group join token` as the canonical term.
- Protocol receive docs must describe `senderAgentName`, `senderDisplayName`, and `groupName` as expected runtime metadata sourced from trusted local/registry resolution, with IDs as fallback identity.
- Protocol send docs must keep canonical routing language (`payload.peer` for direct, `payload.groupId` for groups, mutually exclusive in one request).
- Group reference docs must reflect v2 semantics:
  - create is agent-auth only and auto-adds creator agent as admin
  - join-token issue payload has no role input (member-only issuance)
