# AGENTS.md (scripts)

## Purpose
- Keep workspace helper scripts deterministic and aligned with the current runtime-agnostic connector model.

## Rules
- Do not add provider-specific setup/doctor/install harness logic.
- Keep script flows aligned with current CLI surface (`connector configure|doctor|start|service install`).
- Keep scripts safe for local/dev use with explicit inputs and clear failure messages.
