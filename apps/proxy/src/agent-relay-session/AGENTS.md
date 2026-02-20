# AGENTS.md (apps/proxy/src/agent-relay-session)

## Purpose
- Keep relay Durable Object code modular, deterministic, and below 800 lines per file.

## Rules
- Keep `core.ts` as orchestration only (fetch/alarm lifecycle, queue + delivery flow), not as a utility dump.
- Keep socket liveness/heartbeat/pending-close tracking in `socket-tracker.ts`.
- Keep frame construction/parsing helpers in `frames.ts`; do not duplicate frame payload logic in `core.ts`.
- Keep queue receipt normalization/pruning/upsert/delete behavior in `queue-state.ts`.
- Keep retry delay math in `policy.ts` and alarm scheduling in `scheduler.ts`.
- Keep request payload validation in `parsers.ts` and RPC error envelopes in `rpc.ts`.
- Keep shared relay constants in `constants.ts`; avoid repeating close codes and route paths inline.
