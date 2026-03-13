# AGENTS.md (crates/clawdentity-core/src/registry)

## Purpose
- Keep Rust registry clients compatible with the hosted registry API.

## Rules
- Optional request fields must be omitted when unset instead of serialized as `null` unless the registry contract explicitly allows nulls.
- Keep blocking registry-client code out of async contexts unless wrapped with a blocking boundary.
- Keep `invite redeem` backward compatible at the Rust API layer: `clw_inv_...` must target `/v1/invites/redeem`, while `clw_stp_...` must target `/v1/starter-passes/redeem`.
- Preserve shared redeem response parsing across invite and starter-pass onboarding so config persistence stays identical after success.
