# AGENTS.md (docs)

## Purpose
- Keep product and architecture docs aligned with the current agent-agnostic CLI/API contract.

## Rules
- Document Clawdentity as the runtime-neutral connector contract.
- Keep onboarding docs focused on the current connector commands and agent adapter skill.
- Keep onboarding docs prompt-first with `/agent-skill.md` as canonical and `/skill.md` as an alternate URL.
- Keep outbound examples on `POST /v1/outbound` with xor routing (`toAgentDid` or `groupId`).
- Keep inbound examples on `clawdentity.delivery.v1` and receipt statuses `delivered_to_webhook` / `dead_lettered`.
- Treat `framework` metadata as optional labeling only.
