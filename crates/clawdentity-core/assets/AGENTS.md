# AGENTS.md (crates/clawdentity-core/assets)

## Purpose
- Define rules for optional static assets shipped inside Rust releases.

## Rules
- Keep this folder free of runtime-specific bundled adapters.
- Do not reintroduce copied OpenClaw/PicoClaw/NanoBot/NanoClaw skill bundles here.
- If generic artifacts are added later, keep generation deterministic and source-driven from tracked app/package sources.
