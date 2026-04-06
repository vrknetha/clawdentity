# AGENTS.md (crates/clawdentity-core/src/registry/group)

## Purpose
- Keep group-registry client tests isolated from production client logic in `../group.rs`.

## Rules
- Keep this folder test-only; production parsing/request code stays in `../group.rs`.
- Cover active-token lifecycle contracts in tests:
  - `join-token current` returns active token payload
  - `join-token reset` rotates token
  - `join-token revoke` revokes active token
- Keep member-list fixtures profile-rich (`agentName`, `displayName`, `framework`, `humanDid`, `status`) so test coverage matches runtime contract.
- Keep join-token examples on the reusable active-token model; do not reintroduce `maxUses` or `expiresInSeconds` request fixtures.
