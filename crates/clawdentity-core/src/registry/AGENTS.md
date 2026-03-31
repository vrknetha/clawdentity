# AGENTS.md (crates/clawdentity-core/src/registry)

## Purpose
- Keep Rust registry clients compatible with the hosted registry API.

## Rules
- Optional request fields must be omitted when unset instead of serialized as `null` unless the registry contract explicitly allows nulls.
- Keep blocking registry-client code out of async contexts unless wrapped with a blocking boundary.
- Keep `invite redeem` backward compatible at the Rust API layer: `clw_inv_...` must target `/v1/invites/redeem`, while `clw_stp_...` must target `/v1/starter-passes/redeem`.
- Preserve shared redeem response parsing across invite and starter-pass onboarding so config persistence stays identical after success.
- Keep signed agent-auth registry HTTP logic centralized in shared helpers; do not duplicate `authorization`/`x-claw-agent-access`/PoP signing code across CLI modules.
- Group lifecycle APIs (`create`, `inspect`, `join-token create`, `join`, `members list`) must live in this crate and remain reusable from both CLI command handlers and connector runtime helpers.
- Group input validation in Rust must stay aligned with registry constraints:
  - group IDs via shared DID helpers
  - join tokens with `clw_gjt_` marker
  - join-token issue bounds for `expiresInSeconds` and `maxUses`
