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
- CI command order: install -> base/head setup -> lint -> affected checks.
- Affected checks in CI must include `lint`, `format`, `typecheck`, `test`, and `build`.

## Deployment Rules (Develop)
- `deploy-develop.yml` runs on pushes to `develop`.
- Run full quality gates before deployment: `pnpm lint`, `pnpm -r typecheck`, `pnpm -r build`, `pnpm -r test`.
- Deploy both workers in the same workflow:
  - registry (`apps/registry`, env `dev`) with D1 migration apply before deploy
  - proxy (`apps/proxy`, env `dev`) after registry health passes
- Verify registry health at `https://dev.registry.clawdentity.com/health` and verify proxy health via deployed URL (workers.dev or explicit override) with expected `APP_VERSION`.
- Health verification should use bounded retries (for example 3 minutes with 10-second polling) and `Cache-Control: no-cache` requests to tolerate short edge propagation delays after deploy.
- When using Python `urllib` for health checks, always set explicit request headers (`Accept: application/json` and a custom `User-Agent` such as `Clawdentity-CI/1.0`) because Cloudflare may return `403`/`1010` for the default `Python-urllib/*` user agent.
- Use workflow concurrency groups to prevent overlapping deploys for the same environment.
- Run Wrangler through workspace tooling (`pnpm exec wrangler`) in CI so commands work without a global Wrangler install on GitHub runners.

## Release Rules (CLI)
- `publish-cli.yml` is manual (`workflow_dispatch`) and must accept explicit `version` + `dist_tag` inputs.
- Run CLI quality gates before publish: `pnpm -F clawdentity lint`, `typecheck`, `test`, `build`.
- Publish only package `apps/cli` as npm package `clawdentity`.
- Keep published runtime manifest free of `workspace:*` runtime dependencies.
- Use npm provenance (`--provenance`) and require `NPM_TOKEN` secret.

## Secrets and Permissions
- Required deploy secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
- Mirror to `CF_API_TOKEN` and `CF_ACCOUNT_ID` for tooling compatibility.
- Optional deploy secret: `PROXY_HEALTH_URL` (only needed if proxy workers.dev URL cannot be resolved in CI output).
- Required publish secret: `NPM_TOKEN`.
- Keep Cloudflare token scope minimal for current workflows:
  - `Workers Scripts:Edit`
  - `Workers Routes:Edit` (zone-level, custom domains)
  - `D1:Edit`
  - add `Cloudflare Pages:Edit` only when Pages deploy workflow is introduced.

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
