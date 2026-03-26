# AGENTS.md (packages/connector/src/inbound-inbox)

## Purpose
- Keep inbound inbox durability logic modular, transactional, and corruption-resistant.

## Rules
- Keep data contracts in `types.ts`.
- Keep shared string sanitization helpers in `parse.ts`; do not duplicate optional-string cleanup logic.
- Keep row mapping, payload serialization, and JSON parsing for SQLite records in `records.ts`.
- Keep SQLite schema, queries, and transaction helpers in `storage.ts`; do not spread SQL across `inbound-inbox.ts`.
- Keep `inbound-inbox.ts` focused on inbox behavior and orchestration, not SQL details.
- Preserve request-id dedupe and byte/count accounting through SQL queries rather than cached JSON snapshots.
- Keep writes transactional and event retention bounded by row count.
- Ignore stale JSON inbox artifacts on disk; this module is SQLite-only.
