# AGENTS.md (crates/clawdentity-core/src/providers/openclaw)

## Purpose
- Define guardrails for Rust-owned OpenClaw install, setup, doctor, and relay-test behavior.

## Rules
- `assets.rs` is the single place that projects bundled OpenClaw skill files into local OpenClaw state.
- Keep provider setup self-sufficient: install assets first, then persist runtime metadata derived from the installed config.
- Keep doctor and relay-test compatible with container-mounted OpenClaw homes and explicit env overrides.
- Explicit CLI home/state roots must beat ambient `OPENCLAW_*` env vars; isolated-home runs are a release gate.
- When an explicit home already looks like an OpenClaw profile root (`openclaw.json`, `hooks/`, `skills/`), write directly into that root instead of inventing an extra `.openclaw/` layer.
- Do not reintroduce JS CLI bundle dependencies.
