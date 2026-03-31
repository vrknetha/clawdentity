# AGENTS.md (apps/openclaw-skill/skill/references)

## Purpose
- Keep the modular OpenClaw reference docs aligned with the current runtime contracts.

## Rules
- Document pair payload fields and projected relay snapshot fields separately.
- Pairing examples must keep `humanName` where the pair API still uses it.
- Projected relay snapshot examples must use `displayName` and may include additive metadata such as `framework`, `description`, and `lastSyncedAtMs`.
- When documenting group headers, distinguish proxy routing headers from OpenClaw-facing inbound metadata headers.
- Use `group join token` as the canonical term.
