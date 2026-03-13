# AGENTS.md (crates/clawdentity-cli/src/commands)

## Purpose
- Keep the Rust CLI as the single supported operator surface.

## Rules
- New user-facing commands belong here, not in a parallel JS CLI.
- Keep command JSON output stable and machine-readable.
- Any command that mixes blocking filesystem or blocking HTTP with async runtime must isolate the blocking work with `spawn_blocking` or an equivalent boundary.
- Provider-specific command docs and help text must use `--for <provider>`.
- Commands that accept `--home-dir` must pass that exact state root through every follow-up verification step; do not install into one home and verify another.
- Keep command implementations `clippy -D warnings` clean; fold oversized argument lists into small input structs instead of sprinkling `allow` attributes.
