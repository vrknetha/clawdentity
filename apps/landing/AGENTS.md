# AGENTS.md

## Scope
- These rules apply to `apps/landing`.

## Installer Ownership
- `public/install.sh` and `public/install.ps1` are owned by the landing app.
- Keep installer behavior and docs in sync whenever release artifact naming, supported platforms, or env controls change.
- Installers must continue to install:
  - Unix binary: `clawdentity`
  - Windows binary: `clawdentity.exe`

## Installer Contract (Do Not Drift)
- `CLAWDENTITY_VERSION` is optional and defaults to the latest `rust/v*` GitHub release tag.
- `CLAWDENTITY_INSTALL_DIR` is optional and overrides the destination directory.
- `CLAWDENTITY_INSTALL_DRY_RUN=1` performs a no-write simulation.
- `CLAWDENTITY_NO_VERIFY=1` is the only allowed checksum bypass.
- Checksum verification is enabled by default and must validate against `clawdentity-<version>-checksums.txt`.
- Platform coverage must remain:
  - `install.sh`: Linux + macOS (`x86_64`, `aarch64`)
  - `install.ps1`: Windows (`x86_64`, `aarch64`)

## Generated Artifact Policy
- `public/skill.md` is generated code.
- Generate it only via `scripts/build-skill-md.mjs` (or `pnpm run build:skill-md`).
- Do not manually edit `public/skill.md`.

## Source of Truth
- The canonical source files are:
  - `apps/openclaw-skill/skill/SKILL.md`
  - `apps/openclaw-skill/skill/references/clawdentity-protocol.md`
  - `apps/openclaw-skill/skill/references/clawdentity-registry.md`
  - `apps/openclaw-skill/skill/references/clawdentity-environment.md`
- The generator must keep `SKILL.md` first, then append the three references in that fixed order.

## Script and Build Expectations
- Keep `build:skill-md` as the single helper for generation.
- `dev`, `build`, `preview`, and `check` must run `build:skill-md` first.
- If source skill files or generator logic changes, regenerate `public/skill.md` before shipping.
- Nx landing targets must invoke package scripts (`pnpm run build|dev|preview|check`) instead of calling `astro` directly, so pre-steps always run.
- Include the skill source files (`apps/openclaw-skill/skill/**`) and `scripts/build-skill-md.mjs` in Nx target inputs so cache invalidation remains correct.

## D2 Integration
- Do not make `astro-d2` a hard runtime requirement for every build environment.
- Gate D2 integration by environment/binary availability in `astro.config.mjs`.
- Keep non-D2 CI/build environments green by skipping D2 integration when the binary is unavailable.

## Navigation UX Guardrails
- Mobile menu logic must centralize open/close state updates in one helper.
- Body scroll locking must be cleared when leaving mobile viewport widths (for example, resizing to desktop while menu is open).
- Avoid duplicated DOM state mutations for `aria-expanded`, `nav--open`, and body overflow handling.

## Cloudflare Pages Deploy Expectations
- `develop` branch deploys to Cloudflare Pages preview/staging.
- `main` branch deploys to Cloudflare Pages production.
- Deploy jobs must use package scripts that run `build:skill-md` first so `public/skill.md` is always current.
- Deploy output must include `public/install.sh` and `public/install.ps1` at site root (`/install.sh`, `/install.ps1`).
- Landing docs must keep OS-specific installer commands canonical:
  - Unix: `curl -fsSL https://clawdentity.com/install.sh | sh`
  - Windows: `irm https://clawdentity.com/install.ps1 | iex`
- User-facing onboarding docs must be prompt-first.
- Canonical onboarding prompt source is `/skill.md` (generated from `apps/openclaw-skill/skill/SKILL.md`).
- CLI command-by-command onboarding belongs in advanced/manual fallback sections only.
- Cargo install and direct GitHub release asset flows are fallback-only in docs.
- Rust toolchain requirements must only appear in advanced/developer fallback sections.
- Do not reintroduce deprecated CLI command groups in landing docs; keep examples on current Rust `install` and `provider` commands.
- Keep CLI docs aligned with the current Rust binary command surface (`init`, `whoami`, `register`, `agent`, `config`, `api-key`, `invite`, `admin`, `connector`, `provider`, `install`).
- Do not document unsupported CLI subcommands; if a flow is API-only (for example pairing), document it under proxy API routes instead of inventing CLI syntax.
- DID examples in landing docs must use `did:cdi:<authority>:<entity>:<ulid>`; never use `did:claw:*` format.
