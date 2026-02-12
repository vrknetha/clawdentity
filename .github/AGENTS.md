# GitHub Actions Guardrails

## Purpose
- Make workflow automation predictable, auditable, and safe for this repo's Cloudflare Worker deployments.
- Surface the canonical deploy pipeline for merges into `develop` so every engineer knows which workflow runs migrations, deploys, and verifies the dev Worker.

## Deployment-first practices
- Keep CI (`ci.yml`) focused on lint/typecheck/test/build so shorter feedback loops run on every push/pull request.
- Keep deployment logic in dedicated workflows whose triggers and permissions are explicit (e.g., `deploy-develop.yml` on `develop`).
- Always run migrations before `wrangler deploy` and verify `/health` after the deploy completes.

## Secrets and permissions
- Required secrets for the Cloudflare workflow: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
- Mirror the token into `CF_API_TOKEN`/`CF_ACCOUNT_ID` so both `wrangler`/`pnpm` commands and Cloudflare tooling can resolve the IDs.
- Scope the token down to the least privileges needed: `Workers Scripts:Write`, `Workers Routes:Write`, `Zone:Read`, `D1:Database:Admin + Migrate`, `D1:Database:Read/Write`, and minimal `Account:Read`.

## Workflow expectations
- Each deploy workflow must run `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm -r typecheck`, `pnpm -r test`, and `pnpm -r build` before touching production assets.
- Use `pnpm --filter @clawdentity/registry run deploy:dev` (or equivalent) to keep migration/deploy scripts centralized under `apps/registry`.
- After a deploy, hit the branded health endpoint (`https://dev.api.clawdentity.com/health`) and ensure the response reports `status: "ok"` and `environment: "development"` before marking the job complete.
- Deploy workflows should use concurrency groups to avoid overlapping deploys for the same environment.

## Migration Rollback Strategy (Develop)
- Before migrations/deploy, capture rollback artifacts:
  - `wrangler deployments list --env dev --json` (current Worker versions)
  - `wrangler d1 time-travel info clawdentity-db-dev --timestamp <predeploy-ts> --json`
  - `wrangler d1 export clawdentity-db-dev --remote --output <file.sql>`
- Upload artifacts from every run (success or failure) so operators can recover quickly.
- On failed deploy:
  - Worker rollback: `wrangler rollback <version-id> --env dev`
  - DB rollback: `wrangler d1 time-travel restore clawdentity-db-dev --env dev --timestamp <predeploy-ts>`
