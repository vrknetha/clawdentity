# AGENTS.md (crates/clawdentity-cli/src/commands/onboarding)

## Purpose
- Keep onboarding command orchestration modular and below structural line limits.

## Rules
- Keep `onboarding.rs` focused on command/session orchestration; move implementation and tests into `onboarding/` submodules as the file grows.
- Provider failure classification must remain provider-agnostic:
  - connector runtime failures map from both OpenClaw-specific and generic IDs
  - webhook health failures map to provider-unhealthy, not connector-down
- Keep onboarding tests in `onboarding/tests.rs` aligned with classification and required-input behavior.
