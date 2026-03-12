# AGENTS.md (apps/registry/src/server/helpers)

## Purpose
- Keep shared server helpers reusable, deterministic, and aligned with runtime deployment guarantees.

## Rules
- Event-bus backend selection must stay centralized in `event-bus.ts`; route files must not duplicate backend or queue-binding decisions.
- Production-like queue validation must fail fast with `CONFIG_VALIDATION_FAILED` when `EVENT_BUS_BACKEND=queue` and `EVENT_BUS_QUEUE` is missing.
- Keep helper outputs free of route-specific response shaping; helpers should expose reusable data or side-effect boundaries, not inline HTTP responses.
- Prefer explicit config-driven branching over hostname or branch-name heuristics.
