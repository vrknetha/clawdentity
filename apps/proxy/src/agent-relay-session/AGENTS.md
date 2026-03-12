# AGENTS.md (apps/proxy/src/agent-relay-session)

## Purpose
- Keep relay Durable Object code modular, deterministic, and below 800 lines per file.

## Rules
- Keep `core.ts` as orchestration only (fetch/alarm lifecycle, queue + delivery flow), not as a utility dump.
- Keep queue persistence, pruning, retry sequencing, and alarm coordination in `queue-manager.ts`.
- Keep connector frame send + in-flight ack tracking in `delivery.ts`.
- Keep websocket frame/close/error dispatch in `websocket.ts`.
- Keep socket liveness/heartbeat/pending-close tracking in `socket-tracker.ts`.
- Keep frame construction/parsing helpers in `frames.ts`; do not duplicate frame payload logic in `core.ts`.
- Keep queue receipt normalization/pruning/upsert/delete behavior in `queue-state.ts`.
- Keep retry delay math in `policy.ts` and alarm scheduling in `scheduler.ts`.
- Keep request payload validation in `parsers.ts` and RPC error envelopes in `rpc.ts`.
- Keep shared relay constants in `constants.ts`; avoid repeating close codes and route paths inline.

## Refactor Guidance
- Prefer extracting concrete collaborators (queue management, connector delivery transport, and RPC wiring) so `core.ts` stays a high-level orchestrator with well-defined dependencies.
- When adding new helpers, document the exported signatures and the direction of dependencies (e.g., `core.ts` → `queue-manager` → `queue-state`, `core.ts` → `rpc-handlers` → `parsers`).
- Preserve the existing request/queue/workflow contracts; refactors should not change how RPC paths, receipt state, or delivery retries behave.
