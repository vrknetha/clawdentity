# AGENTS.md (apps/openclaw-skill/skill)

## Purpose
- Keep user-facing skill guidance aligned with current CLI/proxy/registry behavior.

## Documentation Rules
- `SKILL.md` and `references/*.md` must use command-first remediation with executable `clawdentity` commands.
- Pairing error guidance must include `PROXY_PAIR_OWNERSHIP_UNAVAILABLE` and explain proxy internal-service credential recovery.
- Keep invite/ticket prefixes explicit:
  - `clw_inv_...` for onboarding invite redeem
  - `clwpair1_...` for pairing tickets
- Do not document manual registry/proxy host changes unless explicitly needed for a recovery scenario.

## Sync Rules
- When `skill/SKILL.md` or `skill/references/*` changes, regenerate and sync CLI bundle:
  - `pnpm -F @clawdentity/openclaw-skill build`
  - `pnpm -F clawdentity run sync:skill-bundle`
