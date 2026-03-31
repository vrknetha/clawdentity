# AGENTS.md (apps/registry/src/server/helpers)

## Purpose
- Keep shared server helpers reusable, deterministic, and aligned with runtime deployment guarantees.

## Rules
- Event-bus backend selection must stay centralized in `event-bus.ts`; route files must not duplicate backend or queue-binding decisions.
- Production-like queue validation must fail fast with `CONFIG_VALIDATION_FAILED` when `EVENT_BUS_BACKEND=queue` and `EVENT_BUS_QUEUE` is missing.
- Keep helper outputs free of route-specific response shaping; helpers should expose reusable data or side-effect boundaries, not inline HTTP responses.
- Prefer explicit config-driven branching over hostname or branch-name heuristics.
- Public URL helpers must translate loopback runtime URLs into caller-facing URLs using forwarded/host headers so Docker, localhost, and reverse-proxy onboarding flows persist reachable endpoints.
- Registry-facing loopback URLs may adopt the forwarded origin's port semantics, but sibling service URLs such as the proxy must keep their own configured service port when only the hostname/protocol are being remapped.
- Treat bracketed IPv6 loopback hosts (`[::1]`) the same as bare `::1` so local IPv6 setups follow the same caller-facing origin remap path.
- When proxy and registry share loopback/origin helpers, keep the implementation in `@clawdentity/common` instead of maintaining app-local copies.
- Mutation row-count helpers must use strict D1 semantics (`result.meta.changes`) and fail closed with an explicit internal error when the shape is unsupported; do not reintroduce legacy `.changes`/`.rowsAffected` fallbacks.
- Mutation operation names must come from shared constants (`db-mutation-operations.ts`) so route/helper operation IDs cannot drift by typo.
- When mutation shape validation fails, emit a structured log payload (including operation + shape metadata) so production diagnosis is fast.
- Group-read authorization helpers must validate PAT access against the specific group (owner or active-member ownership), not just PAT validity.
- Group member-joined creator notifications must publish through the shared registry event bus as best-effort side effects; join success must never depend on queue publish success.
- Group creator notification fan-out must target active creator-owned agent DIDs and skip self-notifying the joining agent DID when they are the same.
- Group route auth helpers must stay centralized for PAT-or-agent flows:
  - share actor resolution (`human` vs `agent`) in helper modules;
  - share raw-body JSON parsing from verified bytes so auth + PoP verification can run before payload validation on protected mutation routes.
