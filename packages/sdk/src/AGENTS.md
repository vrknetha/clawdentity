# AGENTS.md (packages/sdk/src)

## Purpose
- Follow `packages/sdk/AGENTS.md` as the canonical SDK guidance.
- Keep datetime primitives centralized in `datetime.ts` and exported through `index.ts` (`nowUtcMs`, `toIso`, `nowIso`, `addSeconds`, `isExpired`).
- Keep helper tests focused and deterministic in `datetime.test.ts`.
- Reuse `@clawdentity/common` primitives (for example `isRecord` and safe JSON response parsing) instead of duplicating generic transport helpers in SDK clients.
- Treat DID v2 as required in SDK code paths: only `did:cdi:<authority>:<agent|human>:<ulid>` is valid.
- Prefer `parseAgentDid` / `parseHumanDid` for SDK input validation instead of string checks or `parseDid(...).entity` branching.
- When constructing test/fixture DIDs, always pass explicit authority to `makeAgentDid` / `makeHumanDid` and keep it aligned with issuer host assumptions.
