# AGENTS.md (apps/registry/src)

## Purpose
- Keep runtime entrypoints and route contracts consistent for the registry worker.

## Entrypoints
- `server.ts` is the Cloudflare Worker runtime entrypoint.
- `index.ts` should re-export `server.ts` for package build/test compatibility.

## Health Contract
- `/health` must return HTTP 200 with `{ status, version, environment }` on valid config.
- Invalid runtime config must fail through the shared error handler and return `CONFIG_VALIDATION_FAILED`.

## Validation
- Run `pnpm -F @clawdentity/registry run test` after changing routes or config loading.
- Run `pnpm -F @clawdentity/registry run typecheck` before commit.
- When using fake D1 adapters in route tests, make select responses honor bound parameters so query-shape regressions are caught.
