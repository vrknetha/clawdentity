# AGENTS.md (apps/proxy/src/config)

## Purpose
- Keep proxy runtime config generic, stable, and migration-safe.

## Rules
- Prefer generic names (`DELIVERY_WEBHOOK_*`) for all new behavior.
- Validate and normalize all env/config inputs in one place before runtime use.
- Do not add runtime-specific aliases or fallback config files; use explicit runtime env only.
- Never add runtime-brand-specific logic to proxy config resolution.
