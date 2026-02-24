# AGENTS.md (apps/openclaw-skill/skill)

## Purpose
- Keep user-facing skill guidance aligned with the current Rust CLI command surface and provider runtime behavior.

## Documentation Rules
- `SKILL.md` and `references/*.md` must use command-first remediation with executable Rust CLI commands.
- Treat Node/TypeScript CLI command surfaces as deprecated for this skill. Do not add npm or legacy TS-only execution steps.
- Provider workflows must use `clawdentity install` and `clawdentity provider {status|setup|doctor|relay-test}`.
- When a command is provider-specific, require explicit `--for <openclaw|picoclaw|nanobot|nanoclaw>` in docs.
- Keep a single canonical `SKILL.md` URL path:
  - `https://raw.githubusercontent.com/vrknetha/clawdentity/develop/apps/openclaw-skill/skill/SKILL.md`
- Do not document deprecated command groups that are absent from Rust CLI:
  - `clawdentity openclaw ...`
  - `clawdentity pair ...`
  - `clawdentity verify ...`
  - `clawdentity skill install ...`
- Keep onboarding invite prefix explicit: `clw_inv_...`.
- Do not document manual registry/proxy host changes unless explicitly needed for a recovery scenario.
- Keep CLI install guidance deterministic and fallback-safe:
  - primary path: `rustup` + pinned `cargo install --locked --version <published-version> clawdentity-cli`
  - secondary path: direct GitHub release asset URLs with explicit platform naming (`linux-aarch64`, `linux-x86_64`, `macos-*`, `windows-x86_64`)
  - treat `https://clawdentity.com/install.sh` as best-effort only; never as the only documented path

## Sync Rules
- When `skill/SKILL.md` or `skill/references/*` changes, regenerate and sync CLI bundle:
  - `pnpm -F @clawdentity/openclaw-skill build`
  - `pnpm -F clawdentity run sync:skill-bundle`
  - `pnpm -F clawdentity run verify:skill-bundle`
