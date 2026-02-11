# AGENTS.md (.husky)

## Purpose
- Define git hook standards for local quality gates.

## Hook Rules
- `pre-commit` must run `pnpm lint:staged`, and lint-staged must execute staged-file `biome check --write --no-errors-on-unmatched --files-ignore-unknown=true` plus staged-file `nx affected -t typecheck`.
- `pre-push` must run `nx affected -t lint,format,typecheck,test --base=origin/main --head=HEAD`.
- Hooks should call package scripts instead of duplicating long command logic.

## Maintenance
- Keep hook scripts shell-portable and minimal.
- Update this folder when adding/removing hooks so local checks stay consistent.
