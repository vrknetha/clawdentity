# AGENTS.md (apps/cli/src/config)

## Purpose
- Keep CLI config resolution deterministic across local/dev/prod and hermetic under tests.

## Config Rules
- `manager.ts` must keep precedence stable: file config defaults first, then explicit env overrides.
- State directory selection must be derived from effective registry URL and route to:
  - `~/.clawdentity/states/prod`
  - `~/.clawdentity/states/dev`
  - `~/.clawdentity/states/local`
- Keep routing metadata in `~/.clawdentity/router.json` (`lastRegistryUrl`, `lastState`) so CLI can reopen the last active state when env override is absent.
- Keep one-time migration from older flat `~/.clawdentity/*` into `~/.clawdentity/states/prod/*` non-destructive (copy-only, never overwrite existing state targets).
- Keep human profile config in `manager.ts` (`humanName`) with env override support (`CLAWDENTITY_HUMAN_NAME`) and deterministic precedence.
- `registry-metadata.ts` should be the only module that fetches registry metadata for config bootstrap flows.
- Avoid hidden host coupling in config tests; do not depend on shell-exported `CLAWDENTITY_*` values.

## Testing Rules
- Reset `CLAWDENTITY_*` env overrides in `beforeEach` and set only the variables needed by each test case.
- Assert both positive resolution (`registryUrl`/`proxyUrl`) and precedence behavior (`CLAWDENTITY_REGISTRY_URL` over `CLAWDENTITY_REGISTRY`).
- Include `humanName` precedence coverage (`CLAWDENTITY_HUMAN_NAME` over file config).
