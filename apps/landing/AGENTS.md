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
- `CLAWDENTITY_VERSION` is optional and defaults to the release manifest at `https://downloads.clawdentity.com/rust/latest.json`.
- `CLAWDENTITY_DOWNLOADS_BASE_URL` is optional and overrides the default downloads origin (`https://downloads.clawdentity.com`).
- `CLAWDENTITY_RELEASE_MANIFEST_URL` is optional and overrides the latest manifest URL.
- `CLAWDENTITY_INSTALL_DIR` is optional and overrides the destination directory.
- `CLAWDENTITY_SITE_BASE_URL` is optional and overrides the onboarding guide origin used by generated local `skill.md` content and installer next-step messaging.
- `CLAWDENTITY_SKILL_URL` is optional and overrides the exact onboarding guide URL printed by the installers.
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
- `build:skill-md` may render local `localhost` URLs only when `CLAWDENTITY_SITE_BASE_URL` is explicitly set for local preview/testing; production builds must keep the canonical `https://clawdentity.com` URLs.
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

## Asset Hygiene
- Keep only assets that are referenced by landing source code or Astro config.
- Remove unused duplicates (for example mono/source variants) when they are not imported or referenced.
- Before adding a new asset variant, confirm a real consumer exists in `src/components`, `src/pages`, or config.
- Prefer one canonical format per usage context to avoid parallel unused file sets.

## Stylesheet Organization
- Keep `src/styles/landing.css` focused on core layout/components and below file-size guard limits.
- Place motion/hero/effect sections in `src/styles/landing-motion.css` to keep maintenance and linting stable.
- Preserve stylesheet cascade order by importing `landing-motion.css` after `landing.css` in `src/pages/index.astro`.

## Cloudflare Pages Deploy Expectations
- `develop` branch deploys to dedicated Cloudflare Pages project `clawdentity-site-dev`.
- `main` branch deploys to production Cloudflare Pages project `clawdentity-site`.
- Deploy jobs must use package scripts that run `build:skill-md` first so `public/skill.md` is always current.
- Deploy output must include `public/install.sh` and `public/install.ps1` at site root (`/install.sh`, `/install.ps1`).
- Source installers in `public/` are canonical for both `develop` and `main`; do not fork or rewrite them per branch.
- Both Pages environments must point at the same release downloads surface (`https://downloads.clawdentity.com`) unless an operator explicitly overrides installer env vars at runtime.
- Production deploys must mirror latest operator assets into the R2 artifact bucket:
  - `skill/latest/skill.md`
  - `install.sh`
  - `install.ps1`
- Keep the immutable/versioned skill snapshots in R2 release automation, not in the landing build.
- Landing docs must keep OS-specific installer commands canonical:
  - Unix: `curl -fsSL https://clawdentity.com/install.sh | sh`
  - Windows: `irm https://clawdentity.com/install.ps1 | iex`
- User-facing onboarding docs must be prompt-first.
- Canonical onboarding prompt source is `/skill.md` (generated from `apps/openclaw-skill/skill/SKILL.md`).
- Hosted public onboarding must start at `https://registry.clawdentity.com/v1/onboarding/github/start` and return to `/getting-started/github/`.
- `/getting-started/github/` must stay static/client-rendered: it reads fragment data, renders the starter pass prompt, and keeps manual CLI fallback visible.
- Keep the hosted GitHub path primary for public users and operator invite docs as fallback for private/self-hosted installs.
- Do not place `AGENTS.md` files under `src/pages/**`; Astro will treat them as published routes.
- Any copied shell command built from fragment or user-input values must quote those values as shell literals before rendering.
- CLI command-by-command onboarding belongs in advanced/manual fallback sections only.
- Cargo install and direct GitHub release asset flows are fallback-only in docs.
- Direct binary fallback examples must point to `https://downloads.clawdentity.com/rust/v<version>/...`, not GitHub release URLs.
- Do not hardcode develop-specific download URLs in source docs or source installers.
- Rust toolchain requirements must only appear in advanced/developer fallback sections.
- Do not reintroduce deprecated CLI command groups in landing docs; keep examples on current Rust `install` and `provider` commands.
- Keep CLI docs aligned with the current Rust binary command surface (`init`, `whoami`, `register`, `agent`, `config`, `api-key`, `invite`, `admin`, `connector`, `provider`, `install`).
- Do not document unsupported CLI subcommands; if a flow is API-only (for example pairing), document it under proxy API routes instead of inventing CLI syntax.
- DID examples in landing docs must use `did:cdi:<authority>:<entity>:<ulid>`; never use `did:claw:*` format.
