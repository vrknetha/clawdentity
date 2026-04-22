# AGENTS.md (apps/agent-skill/skill)

## Scope
- Keep this skill generic and portable across any agent runtime.
- Do not include provider detection/setup/doctor/repair flows.

## Contract Rules
- Outbound local API examples must use `POST /v1/outbound` with XOR routing (`toAgentDid` or `groupId`).
- Inbound examples must use `type: "clawdentity.delivery.v1"` and `application/vnd.clawdentity.delivery+json`.
- Receipt success status must be `delivered_to_webhook`.

## Docs Sync
- `apps/landing/public/agent-skill.md` and `apps/landing/public/skill.md` are generated from this file.
- Update this file first, then run landing `build:skill-md`.
