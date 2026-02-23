# Golden Principles

These are non-negotiable engineering rules for the Rust workspace.
Each rule includes WHY it exists and HOW it is enforced.

## 1) 800-line file limit

WHY:
- Long files hide coupling, slow review, and make agent-assisted edits risky.
- Smaller files force explicit boundaries and better module decomposition.

HOW ENFORCED:
- Hard gate: `clawdentity-core/tests/structural.rs` (`no_file_exceeds_800_lines`).
- CI/local test runs fail when a Rust source file exceeds 800 lines.

## 2) No `.unwrap()` outside tests

WHY:
- Runtime panic paths are unacceptable for local relay/identity workflows.
- All user-facing failures must remain explicit and diagnosable.

HOW ENFORCED:
- Hard gate: `clawdentity-core/tests/structural.rs` (`no_unwrap_outside_tests`).
- Test skips `cfg(test)` and `tests/` code but fails on `.unwrap()` in production paths.

## 3) Dependency direction is intentional

WHY:
- Layer inversion causes circular reasoning and brittle behavior.
- Providers and connector must stay decoupled from forbidden upper layers.

HOW ENFORCED:
- Hard gate: `clawdentity-core/tests/structural.rs` (`dependency_direction_enforced`).
- Enforced constraints today:
  - `providers` cannot import `runtime`
  - `connector` cannot import `providers`

## 4) Errors are actionable

WHY:
- Operators need context and remediation, not generic failure strings.
- Better error messages reduce repeated manual debugging.

HOW ENFORCED:
- Code pattern requirement:
  - include context (`field/path/status`) in `CoreError` values
  - include remediation hints in doctor/relay-test outputs
- Validated through code review and command UX checks (not currently a dedicated structural test).

## 5) Public API is minimal

WHY:
- Smaller public surface reduces accidental coupling and versioning burden.
- Internal refactors are safer when only essential items are exposed.

HOW ENFORCED:
- Engineering discipline and review rule:
  - avoid exporting internals without concrete consumers
  - prefer module-private helpers by default
- Not yet hard-gated by a structural test.

## 6) Tests cover failure branches

WHY:
- Relay, pairing, and provider operations are failure-heavy systems.
- Happy-path-only tests miss the exact scenarios users hit in real deployments.

HOW ENFORCED:
- Engineering baseline:
  - include negative-path tests for parser/auth/network/persistence failures
- Guardrails are partly indirect today (structural + unit/integration suites), not a single explicit checker.

## 7) JSON output is consistent

WHY:
- CLI automation depends on stable keys and predictable envelope shapes.
- Mixed plain text and JSON semantics create brittle scripts and onboarding friction.

HOW ENFORCED:
- CLI contract rule:
  - `--json` outputs machine-readable objects with stable field names
- Validated in command tests/review; not yet hard-gated by structural test.

## 8) Prefer boring technology

WHY:
- Reliability and operability matter more than novelty for local-first relay infrastructure.
- Well-known libraries reduce long-term maintenance and onboarding cost.

HOW ENFORCED:
- Technology choices in current stack already reflect this principle:
  - SQLite (`rusqlite`), Axum, Reqwest, Tokio, Ed25519, serde-based JSON
- Enforced by architecture review and incremental design decisions, not a dedicated test.

