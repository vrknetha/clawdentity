# AGENTS.md (crates/clawdentity-core/src/providers)

## Purpose
- Keep provider integrations predictable, secure, and easy to diagnose across platforms.

## Rules
- Every provider must implement the full `PlatformProvider` lifecycle consistently:
  - `detect`
  - `install`
  - `verify`
  - `doctor`
  - `setup`
  - `relay_test`
- Keep provider config changes idempotent; re-running setup/install must update in place without duplicating blocks or clobbering unrelated config.
- Keep webhook auth fail-closed:
  - prefer signed headers or explicit tokens
  - never silently downgrade to unsigned delivery when a secret/token is configured
- Keep doctor check IDs stable and machine-readable; onboarding/repair logic depends on those IDs.
- Use generic check IDs where possible (`connector.runtime`, `webhook.health`) so cross-provider flows can classify failures without provider-specific branching.
- Persist provider runtime state only through shared helpers (`write_provider_agent_marker`, `save_provider_runtime_config`) to keep file naming and shape consistent.
- Provider relay tests must validate real delivery contracts (endpoint path + auth headers), not just HTTP reachability.
