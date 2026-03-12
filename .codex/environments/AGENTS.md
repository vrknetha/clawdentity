# AGENTS.md (.codex/environments)

## Purpose
- Define local Codex environment setup for deterministic worktree onboarding.
- Keep environment bootstrap reproducible without committing secrets.

## Rules
- Keep setup script idempotent and fail-fast when required shared env keys are missing.
- Keep `environment.toml` setup/actions aligned with workspace scripts in `package.json`.
- Use `scripts/env/sync-worktree-env.sh` as the single generator for local `.env` files.
- Do not commit secret-bearing `.env` files; only commit templates (`.env.example`).
- If env contract keys change, update these together in one change:
  - `scripts/env/sync-worktree-env.sh`
  - `.env.example`
  - `apps/*/.env.example`
  - `README.md`
  - repository/app `AGENTS.md` files with env guidance

## Validation
- `pnpm env:sync` should fail with a clear error when shared source is missing.
- `pnpm env:sync` should produce deterministic output for root/app env files.
