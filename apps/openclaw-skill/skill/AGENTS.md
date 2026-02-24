# AGENTS.md (apps/openclaw-skill/skill)

## Purpose
- Keep user-facing skill guidance aligned with the current Rust CLI command surface and provider runtime behavior.

## Documentation Rules
- `SKILL.md` and `references/*.md` must use command-first remediation with executable Rust CLI commands.
- Provider workflows must use `clawdentity install` and `clawdentity provider {status|setup|doctor|relay-test}`.
- When a command is provider-specific, require explicit `--for <openclaw|picoclaw|nanobot|nanoclaw>` in docs.
- Do not document deprecated command groups that are absent from Rust CLI:
  - `clawdentity openclaw ...`
  - `clawdentity pair ...`
  - `clawdentity verify ...`
  - `clawdentity skill install ...`
- Keep onboarding invite prefix explicit: `clw_inv_...`.
- Do not document manual registry/proxy host changes unless explicitly needed for a recovery scenario.

## Sync Rules
- When `skill/SKILL.md` or `skill/references/*` changes, regenerate and sync CLI bundle:
  - `pnpm -F @clawdentity/openclaw-skill build`
  - `pnpm -F clawdentity run sync:skill-bundle`
