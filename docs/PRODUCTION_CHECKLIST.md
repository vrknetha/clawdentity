# Production Checklist

## Goal
- Ship production with Cloudflare Pages as the canonical onboarding host and R2 as the canonical immutable artifact store.

## Domains
- Confirm `clawdentity.com` is active and serving the landing site.
- Confirm `registry.clawdentity.com` routes to the production registry Worker.
- Confirm `proxy.clawdentity.com` routes to the production proxy Worker.
- Confirm `downloads.clawdentity.com` points at the R2 artifact bucket/custom domain.

## Secrets And Vars
- Confirm GitHub environment `production` has:
  - `CLOUDFLARE_API_TOKEN`
  - `CLOUDFLARE_ACCOUNT_ID`
  - `BOOTSTRAP_SECRET`
  - `BOOTSTRAP_INTERNAL_SERVICE_ID`
  - `BOOTSTRAP_INTERNAL_SERVICE_SECRET`
  - `REGISTRY_SIGNING_KEY`
  - `REGISTRY_SIGNING_KEYS`
- Confirm GitHub Actions variables include:
  - `R2_ARTIFACTS_BUCKET`
  - `CLAWDENTITY_DOWNLOADS_BASE_URL`

## Cloudflare Runtime
- Confirm D1 production database `clawdentity-db` exists and migrations apply cleanly.
- Confirm registry production secrets are present in Worker config.
- Confirm proxy production secrets are present in Worker config.
- Confirm proxy Durable Object bindings are deployed.
- Confirm registry queue binding exists for the production event bus path.

## Artifact Publishing
- Confirm the Rust release workflow uploads all six archives plus checksums to:
  - `downloads.clawdentity.com/rust/v<version>/...`
- Confirm the latest manifest exists:
  - `downloads.clawdentity.com/rust/latest.json`
- Confirm the skill snapshots exist:
  - `downloads.clawdentity.com/skill/v<version>/skill.md`
  - `downloads.clawdentity.com/skill/latest/skill.md`
- Confirm the landing production deploy mirrors:
  - `install.sh`
  - `install.ps1`
  - `skill/latest/skill.md`

## Health Gates
- Confirm `https://registry.clawdentity.com/health` returns:
  - `status: "ok"`
  - `environment: "production"`
  - `version` equal to deployed `APP_VERSION`
  - `ready: true`
- Confirm `https://proxy.clawdentity.com/health` returns:
  - `status: "ok"`
  - `environment: "production"`
  - `version` equal to deployed `APP_VERSION`
  - `ready: true`

## Onboarding URLs
- Confirm these return `200`:
  - `https://clawdentity.com/`
  - `https://clawdentity.com/skill.md`
  - `https://clawdentity.com/install.sh`
  - `https://clawdentity.com/install.ps1`

## Release Verification
- Run the staged installer smoke test against the generated manifest before publishing artifacts.
- Verify `clawdentity --version` after install.
- Verify checksums against `clawdentity-<version>-checksums.txt`.
