# AGENTS.md (apps/proxy/src/proxy-trust-state)

## Purpose
- Keep Durable Object trust/pairing state logic modular while preserving the public runtime contract exported from `../proxy-trust-state.ts`.

## Module Boundaries
- `index.ts` re-exports the runtime class surface for this module.
- `controller.ts` owns only request routing (`fetch`) and alarm orchestration (`alarm`).
- `handlers.ts` owns route behavior and response payloads for trust-store RPC paths.
- `storage.ts` owns Durable Object storage IO, normalization of persisted data, and alarm scheduling.
- `utils.ts` owns shared validation and parsing helpers (`parseBody`, `parsePeerProfile`, ticket parse/error mapping).
- `types.ts` owns persisted state shapes and storage keys.

## Invariants
- Keep route dispatch tied to `TRUST_STORE_ROUTES`; do not hardcode duplicate paths.
- Keep ticket normalization/parsing strict and centralized via `parseNormalizedPairingTicket`.
- Keep pairing ticket expiry behavior unchanged:
  - creation rejects expired tickets (`410`)
  - confirm/status delete expired entries before returning `410`
  - alarm cleanup removes expired pending/confirmed entries and re-schedules next alarm.
- Keep pair authorization symmetric using `toPairKey` + `addPeer` for both directions.
- Keep revoked-agent overlays durable and idempotent:
  - `markAgentRevoked` must accept only valid agent DIDs and remain safe for duplicate events.
  - `isAgentRevoked` must be a pure lookup with no side effects.
- Keep storage normalization defensive: ignore malformed persisted records instead of throwing.
- Keep external API stable:
  - class name remains `ProxyTrustState`
  - imports from `./proxy-trust-state.js` must continue working.

## Maintainability
- Add new helper logic in `utils.ts` or `storage.ts` instead of duplicating parsing/validation in handlers.
- Keep handler methods focused on one endpoint each and avoid cross-endpoint side effects.
- If persistence schema changes, update `types.ts` and corresponding normalization logic in `storage.ts` in the same change.
