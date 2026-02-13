# AGENTS.md (apps/registry/src)

## Purpose
- Keep runtime entrypoints and route contracts consistent for the registry worker.

## Entrypoints
- `server.ts` is the Cloudflare Worker runtime entrypoint.
- `index.ts` should re-export `server.ts` for package build/test compatibility.

## Health Contract
- `/health` must return HTTP 200 with `{ status, version, environment }` on valid config.
- Invalid runtime config must fail through the shared error handler and return `CONFIG_VALIDATION_FAILED`.

## Registry Keyset Contract
- `/.well-known/claw-keys.json` is a public endpoint and must remain unauthenticated.
- Return `keys[]` entries with `kid`, `alg`, `crv`, `x`, and `status` so SDK/offline verifiers can consume directly.
- Keep cache headers explicit and short-lived (`max-age=300` + `stale-while-revalidate`) to balance key rotation with client efficiency.

## Validation
- Run `pnpm -F @clawdentity/registry run test` after changing routes or config loading.
- Run `pnpm -F @clawdentity/registry run typecheck` before commit.
- When using fake D1 adapters in route tests, make select responses honor bound parameters so query-shape regressions are caught.
