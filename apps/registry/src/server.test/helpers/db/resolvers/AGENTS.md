# AGENTS.md (apps/registry/src/server.test/helpers/db/resolvers)

## Purpose
- Provide single-responsibility resolver modules for fake DB select behavior.

## Rules
- One file per entity/resolver concern.
- Keep column mapping helpers (`get*SelectColumnValue`) and row resolvers (`resolve*SelectRows`) together per entity.
- Keep functions data-in/data-out only; no external state.
- Re-export all resolver APIs from `index.ts` and keep naming consistent for discoverability.
- If SQL filter parsing needs new behavior, extend shared parser helpers instead of duplicating condition parsing in multiple modules.
