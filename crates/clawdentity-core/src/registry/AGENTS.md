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
- Keep agent-name validation centralized in a shared registry helper (`agent_name`) so all registry clients enforce identical constraints and error messages.
- Group input validation in Rust must stay aligned with registry constraints:
  - group IDs via shared DID helpers
  - join tokens with `clw_gjt_` marker
  - join-token issue bounds for `expiresInSeconds` and `maxUses`
  - group-name max length enforcement must count Unicode characters, not UTF-8 byte length
- Group member listing currently relies on the registry's server-side hard limit (`MAX_GROUP_MEMBERS = 25`); treat it as a bounded read until pagination is introduced.
