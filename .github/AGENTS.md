# AGENTS.md (.github)

## Purpose
- Keep CI workflows deterministic and aligned with local tooling versions.
- Keep deployment workflows explicit, auditable, and recoverable.

## CI Rules
- Pin Node and pnpm versions explicitly in workflow steps.
- Use `fetch-depth: 0` when running `nx affected`.
- Compute and export `NX_BASE` and `NX_HEAD` before invoking affected commands.
- Run root lint (`pnpm lint`) before affected tasks to keep style checks global.
- Avoid duplicate CI runs for PR updates by limiting `push` triggers to long-lived branches (`main`, `develop`) and using `pull_request` for feature branches.

## Quality Gates
- CI command order: install -> base/head setup -> file-size guard (`pnpm check:file-size`) -> lint -> affected checks.
- Affected checks in CI must include `lint`, `format`, `typecheck`, `test`, and `build`.
- File-size guard scope: tracked source files under `apps/**` and `packages/**`, hard limit `800` lines, excluding `dist`, `.wrangler`, `worker-configuration.d.ts`, `drizzle/meta`, and `node_modules`.

## Deployment Rules (Develop)
- `deploy-develop.yml` runs on pushes to `develop`.
- Run full quality gates before deployment: `pnpm lint`, `pnpm -r typecheck`, `pnpm -r build`, `pnpm -r test`.
- Deploy both workers in the same workflow:
  - registry (`apps/registry`, env `dev`) with D1 migration apply before deploy
  - proxy (`apps/proxy`, env `dev`) after registry health passes
- Install dependencies before any `pnpm exec wrangler ...` command so Wrangler is available on clean runners.
- Regenerate Worker type bindings in CI with dotenv overlays disabled (`pnpm -F @clawdentity/registry run types:dev` and `pnpm -F @clawdentity/proxy run types:dev`) and fail on git diff drift for `worker-configuration.d.ts` to prevent stale runtime binding types from shipping.
- Sync proxy internal-service credentials from GitHub secrets on every deploy:
  - `BOOTSTRAP_INTERNAL_SERVICE_ID`
  - `BOOTSTRAP_INTERNAL_SERVICE_SECRET`
  - Push both values into proxy Worker secrets before proxy deploy.
- Add a Wrangler preflight dry-run for both workers before mutating remote state (migrations/deploy):
  - `wrangler deploy --env dev --dry-run --var APP_VERSION:<sha>`
- Verify registry health at `https://dev.registry.clawdentity.com/health` and verify proxy health via deployed URL (workers.dev or explicit override) with expected `APP_VERSION`.
- Add Wrangler deployment existence checks for both services after each deploy (`wrangler deployments list --env dev --json`) before endpoint health probes.
- Health verification should use bounded retries (for example 3 minutes with 10-second polling) and `Cache-Control: no-cache` requests to tolerate short edge propagation delays after deploy.
- When using Python `urllib` for health checks, always set explicit request headers (`Accept: application/json` and a custom `User-Agent` such as `Clawdentity-CI/1.0`) because Cloudflare may return `403`/`1010` for the default `Python-urllib/*` user agent.
- Use workflow concurrency groups to prevent overlapping deploys for the same environment.
- Run Wrangler through workspace tooling (`pnpm exec wrangler`) in CI so commands work without a global Wrangler install on GitHub runners.

## Deployment Rules (Production Runtime)
- Keep registry/proxy production deploy automation separate from landing-site deploy automation; production runtime deploys must not rely on manual `package.json` scripts alone.
- Production runtime workflows must validate and sync all required worker secrets before deploy, including registry signing material and proxy internal-service credentials.
- Production runtime workflows must capture rollback artifacts and provide executable rollback steps for both Workers and the production D1 database before mutating remote state.
- Production health gates must verify the deployed runtime version plus critical dependencies, not only the shallow `/health` JSON shape.
- Production runtime deploy order is strict:
  - registry migrations + deploy
  - registry health/readiness verification
  - proxy deploy
  - proxy health/readiness verification
  - landing/artifact publish only after runtime health passes

## Deployment Rules (Landing)
- `deploy-landing-develop.yml` deploys landing docs/asset output from `develop` to the Pages `develop` branch.
- `deploy-landing.yml` deploys landing docs/asset output from `main` to the Pages `main` branch.
- Both landing deploy workflows must trigger on:
  - `apps/landing/**`
  - `apps/agent-skill/skill/**`
  - `apps/landing/scripts/**`
  - `.github/workflows/deploy-landing*.yml`
- Landing workflows must bootstrap Cloudflare Pages project `clawdentity-site` if missing before deploy.
- Landing workflows must assert generated artifacts exist before invoking `pages deploy`:
  - `apps/landing/dist/agent-skill.md`
  - `apps/landing/dist/skill.md`
  - `apps/landing/dist/install.sh`
  - `apps/landing/dist/install.ps1`
- Production landing deploys must also mirror latest operator assets into R2:
  - `skill/latest/agent-skill.md`
  - `skill/latest/skill.md`
  - `install.sh`
  - `install.ps1`
- Keep Cloudflare Pages as the canonical host for `https://clawdentity.com/agent-skill.md`, `https://clawdentity.com/skill.md`, `https://clawdentity.com/install.sh`, and `https://clawdentity.com/install.ps1`; R2 is the backup/latest mirror, not the primary operator URL.

## Release Rules (Rust)
- `publish-rust.yml` must publish six binary archives per release (Linux x86_64/aarch64, macOS x86_64/aarch64, Windows x86_64/aarch64).
- Rust release assets must always include:
  - `clawdentity-<version>-windows-aarch64.zip`
  - installer scripts copied from `apps/landing/public/install.sh` and `apps/landing/public/install.ps1`
- Rust releases must publish immutable assets to the R2 artifact bucket before or alongside GitHub release mirroring.
- Keep installer resolution independent from GitHub APIs:
  - latest lookup: `https://downloads.clawdentity.com/rust/latest.json`
  - immutable binaries/checksums: `https://downloads.clawdentity.com/rust/v<version>/...`
- Rust release automation must publish these R2-backed artifacts:
  - six platform archives
  - `clawdentity-<version>-checksums.txt`
  - `rust/latest.json`
  - `skill/v<version>/agent-skill.md`
  - `skill/latest/agent-skill.md`
  - `skill/v<version>/skill.md`
  - `skill/latest/skill.md`
- Release CI must smoke-test the staged installer against the generated manifest before uploading artifacts.

## Secrets and Permissions
- Required deploy secrets:
  - `CLOUDFLARE_API_TOKEN`
  - `CLOUDFLARE_ACCOUNT_ID`
  - `BOOTSTRAP_INTERNAL_SERVICE_ID`
  - `BOOTSTRAP_INTERNAL_SERVICE_SECRET`
- Required production deploy/release secrets:
  - `BOOTSTRAP_SECRET`
  - `REGISTRY_SIGNING_KEY`
  - `REGISTRY_SIGNING_KEYS`
- Mirror to `CF_API_TOKEN` and `CF_ACCOUNT_ID` for tooling compatibility.
- Required Cloudflare repo/environment variables:
  - `R2_ARTIFACTS_BUCKET`
  - `CLAWDENTITY_DOWNLOADS_BASE_URL`
- Optional deploy secrets:
  - `REGISTRY_HEALTH_URL` (only needed when dev registry health endpoint is not `https://dev.registry.clawdentity.com`; CI falls back to that URL by default).
  - `PROXY_HEALTH_URL` (only needed when dev proxy health endpoint is not `https://dev.proxy.clawdentity.com`; CI now falls back to that URL if workers.dev output is unavailable).
- Keep Cloudflare token scope minimal for current workflows:
  - `Workers Scripts:Edit`
  - `Workers Routes:Edit` (zone-level, custom domains)
  - `D1:Edit`
  - `Cloudflare Pages:Edit`

## Migration Rollback Strategy (Develop)
- Capture pre-deploy artifacts:
  - `pnpm exec wrangler --cwd apps/registry deployments list --env dev --json`
  - `pnpm exec wrangler --cwd apps/proxy deployments list --env dev --json || true` (non-blocking for first deploy before proxy Worker exists)
  - `pnpm exec wrangler d1 time-travel info clawdentity-db-dev --timestamp <predeploy-ts> --json`
  - `pnpm exec wrangler d1 export clawdentity-db-dev --remote --output "${GITHUB_WORKSPACE}/artifacts/<file.sql>"`
- Keep deploy snapshot collection non-blocking for Worker deployment listings (pre and post) so rollback artifact capture does not fail the workflow when a Worker has no prior deployment history.
- Upload artifacts on every run for operator recovery.
- On failed deploy:
  - Registry rollback: `pnpm exec wrangler --cwd apps/registry rollback <version-id> --env dev`
  - Proxy rollback: `pnpm exec wrangler --cwd apps/proxy rollback <version-id> --env dev`
  - DB rollback: `pnpm exec wrangler d1 time-travel restore clawdentity-db-dev --env dev --timestamp <predeploy-ts>`
