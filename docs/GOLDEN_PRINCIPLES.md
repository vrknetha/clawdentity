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

## 3) Structural limits are hard gates across TypeScript and Rust

WHY:
- Size limits force separation of concerns and improve reviewability.
- Oversized files/functions hide risk and slow safe iteration.

HOW ENFORCED:
- TypeScript hard gate: `pnpm check:structural` (`scripts/structural-check.ts`) enforces max 800 lines for source files under `apps/` and `packages/`.
- Rust hard gates: `crates/clawdentity-core/tests/structural.rs` enforces max 800 lines per Rust file and max 50 lines per non-test function.

## 4) TypeScript production code must avoid unsafe shortcuts

WHY:
- `any`, default exports, and ad-hoc console output hide contract drift and runtime risk.
- Inline string conditionals make policy and routing logic brittle.

HOW ENFORCED:
- `pnpm check:structural` fails production TypeScript on `UNSAFE_ANY`, `DEFAULT_EXPORT`, and `BARE_CONSOLE` violations.
- `pnpm check:structural` emits warnings for `MAGIC_STRING` comparisons to drive constant extraction.

## 5) Dead code is a defect

WHY:
- Commented-out logic creates ambiguity and stale behavior assumptions.
- Version control already preserves history, so dead branches should not remain inline.

HOW ENFORCED:
- TypeScript hard gate: `pnpm check:structural` fails `DEAD_CODE` blocks.
- Rust hard gate: `crates/clawdentity-core/tests/structural.rs` fails commented-out code blocks.

## 6) Public APIs and module boundaries must be documented

WHY:
- Public APIs without docs are unsafe for operators and integrators.
- Missing package/app READMEs slows onboarding and increases misuse risk.

HOW ENFORCED:
- Rust hard gate: `crates/clawdentity-core/tests/structural.rs` fails undocumented `pub fn` / `pub async fn` with `UNDOCUMENTED` violations.
- TypeScript structural check emits warnings when app/package directories in `apps/` and `packages/` are missing `README.md`.

## 7) No panic-path coding in production flows

WHY:
- Runtime panic paths are unacceptable for onboarding/relay operations.
- Failures must be explicit, diagnosable, and recoverable where possible.

HOW ENFORCED:
- Rust hard gate: `no_unwrap_outside_tests` in structural tests.
- TypeScript review/testing rule: avoid crash-prone error swallowing and implicit fatal paths.

## 8) Dependency direction is intentional

WHY:
- Layer inversion causes brittle behavior and hidden coupling.
- Security-critical systems need clear module boundaries.

HOW ENFORCED:
- Rust hard gate: dependency-direction checks in structural tests.
- TypeScript enforcement via review, workspace boundaries, and package layering discipline.

## 9) Errors must be actionable

WHY:
- Operators need context and remediation, not generic failure strings.
- Actionable errors reduce support load and debugging cycles.

HOW ENFORCED:
- Command/API outputs should include context fields and remediation hints where applicable.
- Verified through tests, UX checks, and review.

## 10) Machine-readable outputs are stable

WHY:
- Automation depends on predictable JSON envelopes and field names.
- Mixed text/JSON semantics break scripts and integrations.

HOW ENFORCED:
- CLI/API contracts must preserve stable JSON schemas.
- Regressions are blocked in tests or review before merge.

## 11) Test failure paths, not just happy paths

WHY:
- Relay, pairing, registry auth, and provider operations are failure-heavy.
- Most production incidents happen in degraded/error branches.

HOW ENFORCED:
- TypeScript: Vitest suites include auth/network/validation negative cases.
- Rust: unit/integration + structural tests include failure invariants.

## 12) Documentation is part of the deliverable

WHY:
- Monorepo coordination fails when docs and code diverge.
- Architecture and workflow docs are required to keep TS and Rust changes aligned.

HOW ENFORCED:
- PRs that change behavior must update affected docs in `docs/`.
- `AGENTS.md` points contributors to docs as system of record.

## 13) Prefer boring, durable technology

WHY:
- Reliability and operability matter more than novelty for trust infrastructure.
- Mature tooling lowers long-term maintenance risk.

HOW ENFORCED:
- New dependencies and patterns require clear operational justification.
- Existing stack favors proven runtime/tooling choices (Workers, SQLite/D1, Vitest, Cargo ecosystem).
