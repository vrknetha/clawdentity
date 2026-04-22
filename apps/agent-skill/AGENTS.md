# AGENTS.md (apps/agent-skill)

## Scope
- This package is documentation-only and provides the generic, runtime-agnostic Clawdentity agent skill.
- Keep instructions runtime-neutral; do not include runtime-specific setup or detection flows.

## Authoring Rules
- Keep command examples aligned with current CLI contract:
  - `clawdentity connector configure <agent-name> --delivery-webhook-url <url>`
  - `clawdentity connector doctor <agent-name>`
  - `clawdentity connector start <agent-name>`
  - `clawdentity connector service install <agent-name>`
- Keep outbound API examples aligned with `/v1/outbound` route-xor:
  - exactly one of `toAgentDid` or `groupId`
- Keep inbound delivery examples aligned with `clawdentity.delivery.v1`.

## Publishing
- Landing-generated artifacts must publish this source at `/agent-skill.md`.
- `/skill.md` may exist as an alternate URL but must mirror the same generic content.
