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
- Run full quality gates before deployment: `pnpm lint`, `pnpm -r typecheck`, `pnpm -r test`, `pnpm -r build`.
- Use `pnpm --filter @clawdentity/registry run deploy:dev` so migration+deploy logic stays centralized.
- Verify `https://dev.api.clawdentity.com/health` returns `status: "ok"` and `environment: "development"`.
- Use workflow concurrency groups to prevent overlapping deploys for the same environment.

## Secrets and Permissions
- Required secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
- Mirror to `CF_API_TOKEN` and `CF_ACCOUNT_ID` for tooling compatibility.
- Keep token scope minimal: `Workers Scripts:Write`, `Workers Routes:Write`, `Zone:Read`, `D1:Database:Admin + Migrate`, `D1:Database:Read/Write`, and `Account:Read`.

## Migration Rollback Strategy (Develop)
- Capture pre-deploy artifacts:
  - `wrangler deployments list --env dev --json`
  - `wrangler d1 time-travel info clawdentity-db-dev --timestamp <predeploy-ts> --json`
  - `wrangler d1 export clawdentity-db-dev --remote --output <file.sql>`
- Upload artifacts on every run for operator recovery.
- On failed deploy:
  - Worker rollback: `wrangler rollback <version-id> --env dev`
  - DB rollback: `wrangler d1 time-travel restore clawdentity-db-dev --env dev --timestamp <predeploy-ts>`
