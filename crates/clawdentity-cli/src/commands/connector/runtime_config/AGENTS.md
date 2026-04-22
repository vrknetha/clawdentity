# AGENTS.md (crates/clawdentity-cli/src/commands/connector/runtime_config)

## Purpose
- Keep runtime config resolution small, testable, and aligned to the runtime-neutral connector contract.

## Rules
- Keep delivery webhook config per agent under Clawdentity state at `agents/<agent>/delivery-webhook.json`.
- Validate delivery webhook URLs and optional health URLs before persisting or starting the connector.
- Reject caller-supplied headers that override Clawdentity-owned delivery headers.
- Do not add runtime-specific setup, detection, repair, or install branches here.
- Split validation, persistence, and output helpers before functions exceed structural limits.
