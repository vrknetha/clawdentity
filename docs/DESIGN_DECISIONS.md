# Design Decisions

## Runtime-Agnostic Connector Hard Cut

Date: 2026-04-21

Decision:
- Remove first-party provider support flows.
- Keep a single generic relay + connector contract that any runtime can implement.

Why:
- Provider-specific setup/repair logic created ongoing maintenance and support overhead.
- The stable value of Clawdentity is signed relay + identity correctness, not runtime ownership.

Scope of the cut:
- removed: `provider ...`, `install --for ...`, provider auto-detect/setup/doctor/relay-test
- added: `connector configure|doctor|start|service install`
- removed Rust provider implementations/assets for OpenClaw/PicoClaw/NanoBot/NanoClaw
- replaced OpenClaw-specific delivery status with `delivered_to_webhook`
- moved onboarding to generic adapter skill (`apps/agent-skill`, `/agent-skill.md`)

Non-goals:
- no compatibility bridge that pretends provider support still exists
- no runtime repair flows owned by Clawdentity

Tradeoff:
- runtime operators must own their adapter/webhook endpoint behavior
- Clawdentity keeps responsibility for protocol correctness, relay correctness, and connector durability
