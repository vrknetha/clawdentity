# AGENTS.md (repository root)

## Purpose
- Define repository-wide engineering and documentation guardrails for Clawdentity.
- Keep product docs and issue governance in sync with the active GitHub tracker.
- When shipping features, UX of the user is most important aspect.
- Remember users run clawdentity in the machines which are not exposed to internet.
- The location of the openclaw is here at /Users/dev/Workdir/openclaw which is what we are building the current 
- Based on the changes made to the cli, always plan for changes in skills as well. Both go together

## Core Rules
- Ship maintainable, non-duplicative changes.
- Prefer small, testable increments tied to explicit issue IDs.
- If a simplification/refactor is obvious, include it in the plan and ticket notes.

## Execution Governance
- GitHub issues are the source of truth for sequencing, blockers, and rollout updates.
- Primary execution tracker: https://github.com/vrknetha/clawdentity/issues/74.
- Do not use local execution-order files as governance source.

## Ticket Lifecycle Workflow
- Operate in a self-serve loop for ticket delivery: pick an issue, execute, and keep GitHub status accurate without waiting for manual reminders.
- Standard sequence for every ticket:
  - Select the target issue and confirm blockers from the GitHub issue tracker.
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
- Architecture and rollout docs (for example `ARCHITECTURE.md`) must reflect current deployment gating and verification strategy.
- If backlog shape changes, update README + architecture docs + the relevant GitHub issue threads in the same change.

## Validation Baseline
- Run and pass: `pnpm lint`, `pnpm -r typecheck`, `pnpm -r test`, `pnpm -r build` for implementation changes.
- Lint runs at root (`pnpm lint` via `biome check .`), not per-package.
- For planning/doc changes, verify dependency/order consistency against the active GitHub issue tracker.

## Cloudflare Worker & Wrangler Conventions
- Registry is a **Hono** app deployed as a Cloudflare Worker. Wrangler handles bundling — tsup is only for type generation and local build validation.
- **Environment separation** via wrangler environments in `apps/registry/wrangler.jsonc`:
  - `--env dev` for development (Worker: `clawdentity-registry-dev`, D1: `clawdentity-db-dev`)
  - `--env production` for production (Worker: `clawdentity-registry`, D1: `clawdentity-db`)
- **Local dev** uses `wrangler dev --env dev` with local SQLite. Override vars via per-worker `.env` files (for example `apps/registry/.env`).
- Worktree-safe local env bootstrap must use `scripts/env/sync-worktree-env.sh` with shared source `~/.clawdentity/worktree.env` (override with `CLAWDENTITY_SHARED_ENV_FILE`).
- Run `pnpm env:sync` after cloning or creating a worktree to generate root/app `.env` files deterministically.
- Use `pnpm -F @clawdentity/registry run dev:local` (or root alias `pnpm dev:registry:local`) to apply local D1 migrations before starting dev server.
- **One-touch deploy** scripts in `apps/registry/package.json`:
  - `deploy:dev` — migrates remote dev D1 + deploys dev Worker
  - `deploy:production` — migrates remote prod D1 + deploys prod Worker
- **Secrets** are set via `wrangler secret put <NAME> --env <env>`, never committed.
- Per-worker `.env` files are for local development overrides only. They are gitignored.

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
- Generated files from tools (drizzle-kit, wrangler) should be excluded rather than reformatted, including Worker runtime type outputs (`**/worker-configuration.d.ts`).

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

## Dual OpenClaw Container Baseline (Skill E2E)
- Runtime stack for local dual-agent tests lives in sibling repo `~/Workdir/openclaw`:
  - Compose file: `docker-compose.dual.yml`
  - Containers: `clawdbot-agent-alpha-1` (`localhost:18789`), `clawdbot-agent-beta-1` (`localhost:19001`)
- Clean pre-skill baseline state is persisted as host snapshots:
  - `~/.openclaw-baselines/alpha-kimi-preskill`
  - `~/.openclaw-baselines/beta-kimi-preskill`
- Latest paired-and-approved baseline (saved on 2026-02-17) is:
  - `~/.openclaw-baselines/alpha-kimi-preskill-device-approved-20260217-194756`
  - `~/.openclaw-baselines/beta-kimi-preskill-device-approved-20260217-194756`
  - stable aliases:
    - `~/.openclaw-baselines/alpha-kimi-preskill-device-approved-latest`
    - `~/.openclaw-baselines/beta-kimi-preskill-device-approved-latest`
- Current stable paired baseline (saved on 2026-02-17) is:
  - `~/.openclaw-baselines/alpha-kimi-paired-stable-20260217-200909`
  - `~/.openclaw-baselines/beta-kimi-paired-stable-20260217-200909`
  - stable aliases:
    - `~/.openclaw-baselines/alpha-kimi-paired-stable-latest`
    - `~/.openclaw-baselines/beta-kimi-paired-stable-latest`
- Current env-enabled clean baseline (saved on 2026-02-18) is:
  - `~/.openclaw-baselines/alpha-kimi-env-enabled-20260218-155534`
  - `~/.openclaw-baselines/beta-kimi-env-enabled-20260218-155534`
  - stable aliases:
    - `~/.openclaw-baselines/alpha-kimi-env-enabled-latest`
    - `~/.openclaw-baselines/beta-kimi-env-enabled-latest`
- Baseline contract:
  - OpenClaw config exists (`~/.openclaw/openclaw.json`) with `agents.defaults.model.primary = "kimi-coding/k2p5"`.
  - No Clawdentity relay skill artifacts are installed in workspace yet.
  - This is the restore point for repeated “install skill + onboard + pairing” user-flow tests.
- Restore workflow before each skill test cycle:
  - Stop dual compose stack.
  - Replace `~/.openclaw-alpha` and `~/.openclaw-beta` contents from baseline snapshots.
  - Start dual compose stack.
  - Run skill-install/onboarding flow from that restored state.
  - Recommended fast restore command:
    - `rsync -a --delete ~/.openclaw-baselines/alpha-kimi-paired-stable-latest/ ~/.openclaw-alpha/ && rsync -a --delete ~/.openclaw-baselines/beta-kimi-paired-stable-latest/ ~/.openclaw-beta/`
- Snapshot refresh workflow after reaching a new known-good state:
  - Stop dual compose stack.
  - Copy `~/.openclaw-alpha` and `~/.openclaw-beta` into new timestamped folders under `~/.openclaw-baselines`.
  - Start dual compose stack.
  - Update this section with the new snapshot folder names.
- Env-enabled baseline restore (for prompt-only runs needing provider auth):
  - `rsync -a --delete ~/.openclaw-baselines/alpha-kimi-env-enabled-latest/ ~/.openclaw-alpha/ && rsync -a --delete ~/.openclaw-baselines/beta-kimi-env-enabled-latest/ ~/.openclaw-beta/`
- Pairing issue runbook (`Disconnected (1008): pairing required` in UI):
  - Cause: OpenClaw device approval is pending; this is gateway pairing, not Clawdentity peer trust pairing.
  - Scope clarification:
    - This error is unrelated to proxy trust bootstrap (`/pair/start` + `/pair/confirm`).
    - Fixing this error only restores OpenClaw UI/device access.
    - Clawdentity trust pairing is a separate step for inter-agent relay authorization.
  - Check pending requests:
    - `docker exec clawdbot-agent-alpha-1 sh -lc 'node openclaw.mjs devices list --json'`
    - `docker exec clawdbot-agent-beta-1 sh -lc 'node openclaw.mjs devices list --json'`
  - Approve each pending request ID:
    - `docker exec clawdbot-agent-alpha-1 sh -lc 'node openclaw.mjs devices approve <requestId>'`
    - `docker exec clawdbot-agent-beta-1 sh -lc 'node openclaw.mjs devices approve <requestId>'`
  - Re-open UI:
    - `http://localhost:18789/` and `http://localhost:19001/`

## Scaffold Best Practices
- Start by reviewing README, ARCHITECTURE.md, and the active execution tracker issue so documentation mirrors the execution model.
- Define the workspace layout now: `apps/registry`, `apps/proxy`, `apps/cli`, `packages/sdk`, and `packages/protocol` (with shared tooling such as `pnpm-workspace.yaml`, `tsconfig.base.json`, and `biome.json`) so downstream tickets have a known structure.
- Declare placeholder scripts for lint/test/build (e.g., `pnpm -r lint`, `pnpm -r test`, `pnpm -r build`) and identify the expected toolchain (Biome, Vitest, tsup, etc.) so future work can fill implementations without duplication.
- Document the CI entrypoints (GitHub Actions or another pipeline) that will run the above scripts, so deployment scaffolding can wire the baseline checks without guessing what belongs in initial setup.

## Deployment Scaffold Best Practices
- Always separate dev and production via wrangler environments — never use a single top-level D1 binding.
- Keep `wrangler.jsonc` database IDs in version control (they are not secrets). Secrets go via `wrangler secret put`.
- Deploy scripts should always run migrations before deploy (`db:migrate:remote && wrangler deploy`) for atomic one-touch deploys.
- The `/health` endpoint is the baseline verification target. It returns `{ status, version, environment }`.
- When adding generated files (drizzle migrations, wrangler temp), immediately exclude them from Biome in `biome.json`.
- `tsconfig.json` for Workers must include `"types": ["@cloudflare/workers-types"]` and `"lib": ["esnext"]` to get D1Database and other Worker globals.
