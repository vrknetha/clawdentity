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
