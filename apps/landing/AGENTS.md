# AGENTS.md (apps/landing)

## Scope
- Rules for `apps/landing` docs/site artifacts.

## Skill Artifact Rules
- `public/agent-skill.md` and `public/skill.md` are generated code.
- Generate only via `scripts/build-skill-md.mjs` (`pnpm run build:skill-md`).
- Source of truth is `apps/agent-skill/skill/SKILL.md`.
- Never hand-edit generated skill artifacts.

## Messaging Rules
- Position Clawdentity as a runtime-agnostic relay contract.
- Do not publish provider support claims or provider setup/doctor/install commands.
- Keep docs/examples aligned to current CLI (`connector configure|doctor|start|service install`).
- Keep `/agent-skill.md` canonical and `/skill.md` compatibility-only.

## Installer Rules
- Keep installer behavior and docs in sync with release artifacts.
- Preserve binary naming: `clawdentity` (Unix), `clawdentity.exe` (Windows).
