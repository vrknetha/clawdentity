# AGENTS.md (packages/sdk/src)

## Purpose
- Follow `packages/sdk/AGENTS.md` as the canonical SDK guidance.
- Keep datetime primitives centralized in `datetime.ts` and exported through `index.ts` (`nowUtcMs`, `toIso`, `nowIso`, `addSeconds`, `isExpired`).
- Keep helper tests focused and deterministic in `datetime.test.ts`.
- Reuse `@clawdentity/common` primitives (for example `isRecord` and safe JSON response parsing) instead of duplicating generic transport helpers in SDK clients.
