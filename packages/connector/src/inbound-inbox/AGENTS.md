# AGENTS.md (packages/connector/src/inbound-inbox)

## Purpose
- Keep inbound inbox durability logic modular and corruption-resistant.

## Rules
- Keep data contracts in `types.ts` and schema normalization in `schema.ts`.
- Keep lock/index/events file operations in `storage.ts`; do not duplicate file-lock logic.
- Preserve atomic index write semantics and append-only event logging.
- Keep request-id dedupe and byte/count accounting consistent with index snapshots.
