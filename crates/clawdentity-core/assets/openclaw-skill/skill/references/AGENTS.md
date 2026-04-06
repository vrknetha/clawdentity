# AGENTS.md (crates/clawdentity-core/assets/openclaw-skill/skill/references)

## Purpose
- Keep the Rust-owned mirrored OpenClaw reference docs aligned with the source skill references.

## Rules
- Mirror the source reference docs exactly for contract wording.
- Mirror provider-aware connector wording exactly from source references:
  - OpenClaw hook-routing docs stay OpenClaw-specific
  - non-OpenClaw providers such as Hermes use provider runtime state saved by `provider setup`
  - OpenClaw-only connector flags stay labeled OpenClaw-only
- Keep pair payload fields on `humanName`.
- Keep projected relay snapshot fields on `displayName` and other additive peer metadata fields.
- Use `group join token` as the canonical term.
- Mirror v2 group lifecycle wording exactly from source references:
  - create is agent-auth only and auto-adds creator agent as admin
  - join-token issue has no role input (member-only)
