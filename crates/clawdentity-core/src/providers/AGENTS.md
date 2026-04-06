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
- When setup inputs omit optional runtime fields (for example connector base URL), preserve the previously persisted runtime value instead of clearing it.
- When install/setup omits webhook port overrides, preserve existing configured port values; only change port when an explicit override is passed.
- Validate derived endpoints/URLs before writing config mutations to disk so failed commands do not leave partial provider state.
- Keep webhook auth fail-closed:
  - prefer signed headers or explicit tokens
  - never silently downgrade to unsigned delivery when a secret/token is configured
- Put live delivery auth/signing in `PlatformProvider::build_inbound_request(...)` or `authorize_inbound_request(...)`; connector/runtime code must stay provider-agnostic and only send the returned request.
- Keep doctor check IDs stable and machine-readable; onboarding/repair logic depends on those IDs.
- Use generic check IDs where possible (`connector.runtime`, `webhook.health`) so cross-provider flows can classify failures without provider-specific branching.
- Persist provider runtime state only through shared helpers (`write_provider_agent_marker`, `save_provider_runtime_config`) to keep file naming and shape consistent.
- Keep shared provider runtime state helpers in focused modules (for example `runtime_state.rs`) so `mod.rs` stays within structural limits while remaining the public entrypoint.
- Provider relay tests must validate real delivery contracts (endpoint path + auth headers), not just HTTP reachability.
