# AGENTS.md (apps/landing/public)

## Purpose
- Keep public onboarding assets stable, production-safe, and aligned with the release pipeline.

## Rules
- `install.sh` and `install.ps1` are public entrypoints and must stay compatible with `https://clawdentity.com/install.sh` and `https://clawdentity.com/install.ps1`.
- Installers must resolve latest versions from `https://downloads.clawdentity.com/rust/latest.json`, not from GitHub release APIs.
- Source installer files are canonical for both develop and production Pages deploys; do not fork environment-specific variants unless there is a real second release line.
- Installers must support deterministic overrides for:
  - `CLAWDENTITY_VERSION`
  - `CLAWDENTITY_DOWNLOADS_BASE_URL`
  - `CLAWDENTITY_RELEASE_MANIFEST_URL`
  - `CLAWDENTITY_SITE_BASE_URL`
  - `CLAWDENTITY_SKILL_URL`
  - `CLAWDENTITY_INSTALL_DIR`
  - `CLAWDENTITY_INSTALL_DRY_RUN=1`
  - `CLAWDENTITY_NO_VERIFY=1`
- `CLAWDENTITY_SITE_BASE_URL` should be enough for local/operator preview environments; `CLAWDENTITY_SKILL_URL` is the escape hatch when only the final prompt URL needs to differ.
- `CLAWDENTITY_INSTALL_DRY_RUN=1` must still resolve the latest manifest metadata when `CLAWDENTITY_VERSION` is unset, so preview mode works without pinning a version.
- Checksum verification stays default-on and must validate against `clawdentity-<version>-checksums.txt`.
- Shell cleanup/trap paths must stay explicit `if ...; then ...; fi` blocks under `set -e`; do not rely on `[ ... ] && ...` tests that can flip successful installs into non-zero exits.
- `skill.md` is generated output; never edit it by hand.
