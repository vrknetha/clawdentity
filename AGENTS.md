# AGENTS.md (repository root)

## Purpose
- Define repository-wide engineering and documentation guardrails for Clawdentity.
- Keep product docs, issue specs, and execution order in sync.

## Core Rules
- Ship maintainable, non-duplicative changes.
- Prefer small, testable increments tied to explicit issue IDs.
- If a simplification/refactor is obvious, include it in the plan and ticket notes.

## Deployment-First Execution
- Enforce `T00 -> T37 -> T38` before feature implementation.
- Feature tickets `T01`-`T36` must not proceed until `T38` is complete.
- Source of truth for sequencing: `issues/EXECUTION_PLAN.md`.

## Issue Governance
- Ticket schema and quality rules are maintained in `issues/AGENTS.md`.
- Any dependency/wave changes must update both affected `T*.md` files and `issues/EXECUTION_PLAN.md` in the same change.

## Ticket Lifecycle Workflow
- Operate in a self-serve loop for ticket delivery: pick an issue, execute, and keep GitHub status accurate without waiting for manual reminders.
- Standard sequence for every ticket:
  - Select the target issue and confirm blockers from `issues/EXECUTION_PLAN.md` and `issues/T*.md`.
  - Start from latest `develop`: `git checkout develop && git pull --ff-only`.
  - Create a feature branch with `feature/` prefix scoped to the ticket.
  - Implement the ticket with tests/docs updates required by the issue definition.
  - Run required validations before pushing.
  - Push branch and open a PR to `develop`.
  - Update the issue with implementation summary, validation evidence, and PR link.
  - Keep issue status aligned to reality:
    - `OPEN` while implementation work is in progress.
    - Close once implementation for the ticket is complete and evidence is posted, even if external operational follow-ups (for example missing CI secrets or environment access) remain.
    - Track external blockers in a separate follow-up issue/comment and link it from the closed ticket.
  - Inform the user after PR + issue update with links and any blockers needing action.

## Documentation Sync
- `README.md` must reflect current execution model and links to issue governance.
- `PRD.md` must reflect current rollout order, deployment gating, and verification strategy.
- If backlog shape changes (`Txx` additions/removals), update README + PRD + execution plan together.

## Validation Baseline
- Run and pass: `pnpm lint`, `pnpm -r typecheck`, `pnpm -r test`, `pnpm -r build` for implementation changes.
- Lint runs at root (`pnpm lint` via `biome check .`), not per-package.
- For planning/doc changes, run dependency/order consistency checks in `issues/EXECUTION_PLAN.md`.

## Cloudflare Worker & Wrangler Conventions
- Registry is a **Hono** app deployed as a Cloudflare Worker. Wrangler handles bundling — tsup is only for type generation and local build validation.
- **Environment separation** via wrangler environments in `apps/registry/wrangler.jsonc`:
  - `--env dev` for development (Worker: `clawdentity-registry-dev`, D1: `clawdentity-db-dev`)
  - `--env production` for production (Worker: `clawdentity-registry`, D1: `clawdentity-db`)
- **Local dev** uses `wrangler dev --env dev` with local SQLite. Override vars via `apps/registry/.dev.vars` (gitignored).
- Use `pnpm -F @clawdentity/registry run dev:local` (or root alias `pnpm dev:registry:local`) to apply local D1 migrations before starting dev server.
- **One-touch deploy** scripts in `apps/registry/package.json`:
  - `deploy:dev` — migrates remote dev D1 + deploys dev Worker
  - `deploy:production` — migrates remote prod D1 + deploys prod Worker
- **Secrets** are set via `wrangler secret put <NAME> --env <env>`, never committed.
- `.dev.vars` is for local development overrides only. It is gitignored.

## Database & Migrations
- ORM: **Drizzle** with SQLite dialect targeting Cloudflare D1.
- Schema source of truth: `apps/registry/src/db/schema.ts`.
- Generate migrations: `pnpm -F @clawdentity/registry run db:generate` (outputs to `apps/registry/drizzle/`).
- Apply locally: `pnpm -F @clawdentity/registry run db:migrate:local`.
- Drizzle meta files (`drizzle/meta/`) are excluded from Biome via `biome.json`.
- Wrangler reads migrations from the `drizzle/` directory (`migrations_dir = "drizzle"` in wrangler.jsonc).
- HLD Section 5 defines the canonical schema: humans, agents, revocations, api_keys, invites.

## Biome Configuration
- `biome.json` at repo root covers all `packages/**` and `apps/**`.
- Excluded from Biome: `**/dist`, `**/drizzle/meta`, `**/.wrangler`.
- Generated files from tools (drizzle-kit, wrangler) should be excluded rather than reformatted.

## CI Pipeline
- `.github/workflows/ci.yml` runs on push and pull_request.
- Steps: `pnpm install --frozen-lockfile` -> set `NX_BASE`/`NX_HEAD` -> `pnpm lint` -> `pnpm affected:ci`.
- CI must run `actions/checkout` with `fetch-depth: 0` so `nx affected` can resolve the commit graph.
- `pnpm affected:ci` must include `lint`, `format`, `typecheck`, `test`, and `build`.

## Local Quality Gates
- Husky hooks are required for local checks (`prepare` installs hooks).
- `pre-commit` runs `pnpm lint:staged` (staged-file `biome check --write --no-errors-on-unmatched --files-ignore-unknown=true` and staged-file `nx affected -t typecheck`).
- `pre-push` runs `nx affected -t lint,format,typecheck,test --base=origin/main --head=HEAD`.
- Keep pre-commit fast: staged-file linting only, with impacted project checks delegated to `nx affected`.
- Workspace Node runtime is pinned in `.npmrc` via `use-node-version=22.16.0` to match `engines.node` and prevent unsupported-engine drift.

## Testing Patterns
- Use **Vitest** for all tests.
- Hono apps are tested via `app.request()` (Hono's built-in test client) — no wrangler or miniflare needed for unit tests.
- Pass mock bindings as the third argument: `app.request("/path", {}, { DB: {}, ENVIRONMENT: "test" })`.

## User-Like E2E Skill Testing
- Validate onboarding and relay flows as a real user path, not as manual local shortcuts.
- Start backend services locally with Wrangler (registry/proxy) using the expected environment before E2E checks.
- Run OpenClaw agents in Docker and test through agent skills only; do not pre-configure relay files by hand.
- Install via npm + skill entrypoint (`npm install clawdentity --skill`) and let the skill perform remaining setup.
- Use invite-code onboarding exactly as production intent: admin creates invite code, agent asks its human for the code, then agent completes setup.
- Verify resulting agent filesystem/config artifacts are created by the skill in the expected locations.
- Confirm end-to-end communication between at least two agents after setup (for example alpha <-> beta relay path).
- If a skill-run test fails because of partial/dirty skill-created state, clean/revert only skill-generated setup and rerun from a fresh user-like starting point.

## T00 Scaffold Best Practices
- Start T00 by confirming the deployment-first order (`T00 -> T37 -> T38`) and reviewing README/PRD/`issues/EXECUTION_PLAN.md` so documentation mirrors the execution model.
- Define the workspace layout now: `apps/registry`, `apps/proxy`, `apps/cli`, `packages/sdk`, and `packages/protocol` (with shared tooling such as `pnpm-workspace.yaml`, `tsconfig.base.json`, and `biome.json`) so downstream tickets have a known structure.
- Declare placeholder scripts for lint/test/build (e.g., `pnpm -r lint`, `pnpm -r test`, `pnpm -r build`) and identify the expected toolchain (Biome, Vitest, tsup, etc.) so future work can fill implementations without duplication.
- Document the CI entrypoints (GitHub Actions or another pipeline) that will run the above scripts, so deployment scaffolding (T37/T38) can wire the baseline checks without guessing what belongs in T00.

## T37/T38 Deployment Scaffold Best Practices
- Always separate dev and production via wrangler environments — never use a single top-level D1 binding.
- Keep `wrangler.jsonc` database IDs in version control (they are not secrets). Secrets go via `wrangler secret put`.
- Deploy scripts should always run migrations before deploy (`db:migrate:remote && wrangler deploy`) for atomic one-touch deploys.
- The `/health` endpoint is the baseline verification target. It returns `{ status, version, environment }`.
- When adding generated files (drizzle migrations, wrangler temp), immediately exclude them from Biome in `biome.json`.
- `tsconfig.json` for Workers must include `"types": ["@cloudflare/workers-types"]` and `"lib": ["esnext"]` to get D1Database and other Worker globals.
