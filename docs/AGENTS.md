# AGENTS.md (docs)

## Purpose
- Keep product and architecture docs aligned with real CLI behavior.
- Keep OpenClaw guidance in rookie English: OpenClaw first, Clawdentity second.

## Rules
- When docs mention the OpenClaw flow, state clearly that OpenClaw owns OpenClaw setup and gateway auth.
- Do not imply `clawdentity provider setup --for openclaw` repairs broken OpenClaw auth or replaces `openclaw onboard` / `openclaw doctor --fix`.
- Use `openclaw dashboard` or `openclaw dashboard --no-open` as the first visual recovery step when device approvals or local UI state are involved.
- Keep `clawdentity connector start` documented as advanced/manual foreground recovery, not the default OpenClaw onboarding path.
- Keep proxy identity docs header-first by default: structured headers and connector metadata are canonical, while message-body identity injection is opt-in legacy compatibility only.
- Keep pair-profile docs and registry-profile docs separate:
  - pair payloads still use `humanName`
  - registry profile lookup and projected relay snapshots use `displayName`
- Be explicit about helper-route scope in docs:
  - `GET /v1/agents/profile` is currently an authenticated directory-style lookup
  - `GET /v1/groups/:id` remains resource-scoped and must not be described as globally readable
- Keep group wording exact:
  - `group join token` is the canonical term
  - do not reintroduce `group invite` in docs
- When group headers are documented, distinguish relay-to-proxy routing headers from OpenClaw-facing inbound metadata headers instead of blending them into one contract.
- If doctor check IDs or remediation wording changes in Rust, update the matching documentation in `README.md`, `docs/ARCHITECTURE.md`, `docs/DESIGN_DECISIONS.md`, and the OpenClaw skill sources in the same change.
