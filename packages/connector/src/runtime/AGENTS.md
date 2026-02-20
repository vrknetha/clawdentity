# AGENTS.md (packages/connector/src/runtime)

## Purpose
- Keep connector runtime orchestration readable by separating auth, transport, relay, and server concerns.

## Rules
- Keep auth disk sync/persistence in `auth-storage.ts`; avoid ad-hoc credential writes.
- Keep hook-delivery retry and abort behavior in `openclaw.ts`.
- Keep replay/probe policy loading and retry-delay calculations in `policy.ts`.
- Keep outbound relay and receipt callbacks in `relay-service.ts`.
- Keep HTTP route handling in `server.ts` and avoid embedding route logic in helpers.
- Keep URL/header/parse helpers focused in `url.ts`, `ws.ts`, and `parse.ts`.
