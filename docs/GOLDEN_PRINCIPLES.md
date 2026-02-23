# Golden Principles

These are non-negotiable engineering rules for the full Clawdentity monorepo (apps, packages, crates, and docs).
Each rule includes WHY it exists and HOW it is enforced today.

## 1) Security and identity correctness first

WHY:
- Clawdentity is a trust and relay system; correctness failures are security failures.
- Identity, signature, revocation, and policy checks must be reliable before optimization.

HOW ENFORCED:
- Architecture and protocol reviews are mandatory for auth/identity changes.
- Verification behavior is tested in TypeScript and Rust test suites.

## 2) Shared protocol contract is canonical

WHY:
- Registry, proxy, SDK, connector, and CLI implementations must agree on wire semantics.
- Contract drift causes interoperability and security regressions.

HOW ENFORCED:
- Protocol-affecting changes must update shared protocol docs/packages and dependent implementations.
- Cross-ecosystem tests and review check for compatibility impact.

## 3) Keep files and modules small

WHY:
- Large files hide coupling, slow review, and increase regression risk.
- Small modules force explicit boundaries and easier ownership.

HOW ENFORCED:
- TypeScript gate: `pnpm check:file-size` (apps/packages source files >800 lines fail).
- Rust gate: `crates/clawdentity-core/tests/structural.rs` (`no_file_exceeds_800_lines`).

## 4) No panic-path coding in production flows

WHY:
- Runtime panic paths are unacceptable for onboarding/relay operations.
- Failures must be explicit, diagnosable, and recoverable where possible.

HOW ENFORCED:
- Rust hard gate: `no_unwrap_outside_tests` in structural tests.
- TypeScript review/testing rule: avoid crash-prone error swallowing and implicit fatal paths.

## 5) Dependency direction is intentional

WHY:
- Layer inversion causes brittle behavior and hidden coupling.
- Security-critical systems need clear module boundaries.

HOW ENFORCED:
- Rust hard gate: dependency-direction checks in structural tests.
- TypeScript enforcement via review, workspace boundaries, and package layering discipline.

## 6) Errors must be actionable

WHY:
- Operators need context and remediation, not generic failure strings.
- Actionable errors reduce support load and debugging cycles.

HOW ENFORCED:
- Command/API outputs should include context fields and remediation hints where applicable.
- Verified through tests, UX checks, and review.

## 7) Machine-readable outputs are stable

WHY:
- Automation depends on predictable JSON envelopes and field names.
- Mixed text/JSON semantics break scripts and integrations.

HOW ENFORCED:
- CLI/API contracts must preserve stable JSON schemas.
- Regressions are blocked in tests or review before merge.

## 8) Test failure paths, not just happy paths

WHY:
- Relay, pairing, registry auth, and provider operations are failure-heavy.
- Most production incidents happen in degraded/error branches.

HOW ENFORCED:
- TypeScript: Vitest suites include auth/network/validation negative cases.
- Rust: unit/integration + structural tests include failure invariants.

## 9) Documentation is part of the deliverable

WHY:
- Monorepo coordination fails when docs and code diverge.
- Architecture and workflow docs are required to keep TS and Rust changes aligned.

HOW ENFORCED:
- PRs that change behavior must update affected docs in `docs/`.
- `AGENTS.md` points contributors to docs as system of record.

## 10) Prefer boring, durable technology

WHY:
- Reliability and operability matter more than novelty for trust infrastructure.
- Mature tooling lowers long-term maintenance risk.

HOW ENFORCED:
- New dependencies and patterns require clear operational justification.
- Existing stack favors proven runtime/tooling choices (Workers, SQLite/D1, Vitest, Cargo ecosystem).
