# AGENTS.md (apps/openclaw-skill/skill)

## Purpose
- Keep user-facing skill guidance aligned with the current Rust CLI command surface and provider runtime behavior.

## Documentation Rules
- Treat `skill/SKILL.md`, `skill/references/*.md`, and `skill/examples/*` as source modular files.
- Keep the published consolidated landing artifact canonical at `https://clawdentity.com/skill.md`.
- Keep `SKILL.md` onboarding prompt-first with a single canonical quick prompt block near the top.
- Keep GitHub raw URL mentions as fallback only (never canonical).
- `SKILL.md` and `references/*.md` must use command-first remediation with executable Rust CLI commands.
- Treat Rust CLI command surfaces as the source of truth for this skill. Do not add npm or TS-only execution steps.
- Provider workflows must use `clawdentity install` and `clawdentity provider {status|setup|doctor|relay-test}`.
- When a command is provider-specific, require explicit `--for <openclaw|picoclaw|nanobot|nanoclaw>` in docs.
- Keep a single canonical skill URL path:
  - `https://clawdentity.com/skill.md`
- Keep a non-canonical fallback mirror path:
  - `https://raw.githubusercontent.com/vrknetha/clawdentity/develop/apps/openclaw-skill/skill/SKILL.md`
- Do not document deprecated command groups that are absent from Rust CLI.
- Keep onboarding invite prefix explicit: `clw_inv_...`.
- Do not document manual registry/proxy host changes unless explicitly needed for a recovery scenario.
- Keep CLI install guidance deterministic and fallback-safe:
  - primary path: hosted installers `https://clawdentity.com/install.sh` and `https://clawdentity.com/install.ps1`
  - do not state or imply Rust toolchain is required for the recommended install path
  - installer env contract must stay documented: `CLAWDENTITY_VERSION`, `CLAWDENTITY_INSTALL_DIR`, `CLAWDENTITY_INSTALL_DRY_RUN=1`, `CLAWDENTITY_NO_VERIFY=1`
  - installer checksum verification is default; bypass only when `CLAWDENTITY_NO_VERIFY=1`
  - fallback path: `rustup` + `cargo install --locked clawdentity-cli`
  - optional deterministic pin: `cargo install --locked --version <version> clawdentity-cli`
  - secondary fallback path: direct GitHub release assets with explicit platform naming (`linux-aarch64`, `linux-x86_64`, `macos-*`, `windows-x86_64`, `windows-aarch64`)
  - avoid hardcoding specific release numbers in docs; use `<version>` placeholders unless a user explicitly asks for a pinned version

## Sync Rules
- Keep `apps/landing/src/content/docs/guides/openclaw-skill.mdx` aligned with the consolidated `/skill.md` artifact wording while preserving local install artifact paths.
- Keep `apps/landing/src/content/docs/getting-started/installation.mdx` aligned with installer defaults and fallback ordering.
- Keep `apps/landing/src/content/docs/getting-started/quickstart.mdx` prompt-first and aligned with the canonical quick prompt text from `SKILL.md`.
- When `skill/SKILL.md` or `skill/references/*` changes, regenerate and sync CLI bundle:
  - `pnpm -F @clawdentity/openclaw-skill build`
  - `pnpm -F clawdentity run sync:skill-bundle`
  - `pnpm -F clawdentity run verify:skill-bundle`
