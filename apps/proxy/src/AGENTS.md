# AGENTS.md (apps/proxy/src)

## Purpose
- Guard relay proxy runtime and delivery/receipt behavior.

## Rules
- Keep proxy trust verification and queue handling deterministic and testable.
- Keep receipt event contracts aligned with connector/runtime status values.
- Keep config parsing backward-compatible when practical, but avoid adding new provider-specific assumptions.
- Do not couple proxy runtime behavior to any single agent runtime brand.
