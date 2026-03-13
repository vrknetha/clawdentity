# AGENTS.md (apps/openclaw-skill/src/transforms)

## Purpose
- Guard transform-source behavior for relay handoff, peer snapshot loading, and OpenClaw-local runtime metadata.

## Rules
- Keep runtime-config path handling deterministic: explicit absolute paths win, relative paths stay relative to `hooks/transforms/`.
- Keep connector endpoint candidates stable: exact override first, container-safe fallbacks after it.
- Do not bypass `peers-config.ts` for peer alias loading or validation.
- Keep transform logic free of direct registry/proxy calls; local connector handoff is the only outbound path here.

## Testing
- Cover both default runtime metadata and explicit override behavior in transform tests.
- Keep tests filesystem-isolated with temp directories or mocks; never depend on a real OpenClaw home.
