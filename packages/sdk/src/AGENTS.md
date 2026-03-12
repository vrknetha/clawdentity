# AGENTS.md (packages/sdk/src)

## Purpose
- Follow `packages/sdk/AGENTS.md` as the canonical SDK guidance.
- Keep datetime primitives centralized in `datetime.ts` and exported through `index.ts` (`nowUtcMs`, `toIso`, `nowIso`, `addSeconds`, `isExpired`).
- Keep helper tests focused and deterministic in `datetime.test.ts`.
- Reuse `@clawdentity/common` primitives (for example `isRecord` and safe JSON response parsing) instead of duplicating generic transport helpers in SDK clients.
- Keep structured logging configurable but deterministic:
  - logger-level filtering belongs in `logging.ts`
  - request logging suppression options (`onlyErrors`, slow-request threshold) must stay additive and backward-compatible for current callers
  - when callers combine restrictive logger levels with suppressed request logs, `logging.ts` must allow slow/error completion events to be emitted at a higher level so production evidence is not lost
- Treat DID v2 as required in SDK code paths: only `did:cdi:<authority>:<agent|human>:<ulid>` is valid.
- Prefer `parseAgentDid` / `parseHumanDid` for SDK input validation instead of string checks or `parseDid(...).entity` branching.
- When constructing test/fixture DIDs, always pass explicit authority to `makeAgentDid` / `makeHumanDid` and keep it aligned with issuer host assumptions.
