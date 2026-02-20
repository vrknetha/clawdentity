# AGENTS.md (apps/registry/src/server)

## Purpose
- Keep registry runtime composition modular and behavior-stable.
- Preserve external contracts while splitting route and helper responsibilities.

## Entry Contract
- `../server.ts` must remain the public facade export used by existing imports/tests.
- `index.ts` in this folder is the composition entrypoint and must export:
  - default app instance (`createRegistryApp()`)
  - named `createRegistryApp` factory.

## Module Boundaries
- `create-registry-app.ts`: app wiring only (middleware, config cache, event bus cache, rate limits, route registration).
- `constants.ts`: shared types and immutable constants.
- `helpers/*.ts`: reusable pure helpers and data-access helpers.
- `routes/*.ts`: route registration only; keep per-route behavior and status codes unchanged.

## Safety Rules
- Do not duplicate parser/query logic across route files; lift shared behavior to `helpers/`.
- Keep environment-aware error exposure unchanged (`shouldExposeVerboseErrors` paths).
- Preserve transaction-first flow and local rollback fallbacks where present.
- Keep route registration order stable unless a route conflict requires change.

## Validation
- For server changes, run:
  - `pnpm -C apps/registry typecheck`
  - `pnpm -C apps/registry test -- server`
