# AGENTS.md (packages/connector/src/runtime)

## Purpose
- Keep connector runtime orchestration readable by separating auth, transport, relay, and server concerns.

## Rules
- Keep runtime auth refresh/sync orchestration in `auth-lifecycle.ts`; treat `auth-storage.ts` as persistence/shape helpers only.
- Keep auth disk sync/persistence in `auth-storage.ts`; avoid ad-hoc credential writes.
- Keep OpenClaw hook-token sync precedence in `openclaw-hook-token.ts` so explicit token overrides remain centralized.
- Keep hook-delivery retry and abort behavior in `openclaw.ts`.
- Keep gateway probe in-flight/health transitions in `openclaw-probe.ts`; avoid duplicate probe loops in `runtime.ts`.
- Keep replay/probe policy loading and retry-delay calculations in `policy.ts`.
- Keep replay orchestration and receipt callbacks in `replay.ts`; avoid re-embedding lane scheduling and dead-letter transitions in `runtime.ts`.
- Keep outbound relay and receipt callbacks in `relay-service.ts`; receipt posts must target validated `replyTo` URLs directly and enforce trusted-origin checks.
- Keep HTTP route handling in `server.ts` and avoid embedding route logic in helpers.
- Keep URL/header/parse helpers focused in `url.ts`, `ws.ts`, and `parse.ts`.
- Keep OpenClaw receipt payload shaping in `openclaw.ts` so `/hooks/agent` (`message`) and `/hooks/wake` (`text`) compatibility stays centralized.
