# AGENTS.md (crates/clawdentity-core/src/runtime)

## Purpose
- Guard the embedded local runtime HTTP/WebSocket surfaces used by connector mode.

## Rules
- Runtime request handlers must accept the currently published OpenClaw relay envelope contract until a coordinated asset release changes it.
- Additive compatibility is preferred over breaking runtime request-shape changes.
- Keep status and dead-letter endpoints machine-readable and stable for doctor/relay-test automation.
