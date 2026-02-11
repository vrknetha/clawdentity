# AGENTS.md (repository root)

## Purpose
- Define repository-wide engineering and documentation guardrails for Clawdentity.
- Keep product docs, issue specs, and execution order in sync.

## Core Rules
- Ship maintainable, non-duplicative changes.
- Prefer small, testable increments tied to explicit issue IDs.
- If a simplification/refactor is obvious, include it in the plan and ticket notes.

## Deployment-First Execution
- Enforce `T00 -> T37 -> T38` before feature implementation.
- Feature tickets `T01`-`T36` must not proceed until `T38` is complete.
- Source of truth for sequencing: `issues/EXECUTION_PLAN.md`.

## Issue Governance
- Ticket schema and quality rules are maintained in `issues/AGENTS.md`.
- Any dependency/wave changes must update both affected `T*.md` files and `issues/EXECUTION_PLAN.md` in the same change.

## Documentation Sync
- `README.md` must reflect current execution model and links to issue governance.
- `PRD.md` must reflect current rollout order, deployment gating, and verification strategy.
- If backlog shape changes (`Txx` additions/removals), update README + PRD + execution plan together.

## Validation Baseline
- Run and pass: `pnpm -r lint`, `pnpm -r test`, `pnpm -r build` for implementation changes.
- For planning/doc changes, run dependency/order consistency checks in `issues/EXECUTION_PLAN.md`.

## T00 Scaffold Best Practices
- Start T00 by confirming the deployment-first order (`T00 -> T37 -> T38`) and reviewing README/PRD/`issues/EXECUTION_PLAN.md` so documentation mirrors the execution model.
- Define the workspace layout now: `apps/registry`, `apps/proxy`, `apps/cli`, `packages/sdk`, and `packages/protocol` (with shared tooling such as `pnpm-workspace.yaml`, `tsconfig.base.json`, and `biome.json`) so downstream tickets have a known structure.
- Declare placeholder scripts for lint/test/build (e.g., `pnpm -r lint`, `pnpm -r test`, `pnpm -r build`) and identify the expected toolchain (Biome, Vitest, tsup, etc.) so future work can fill implementations without duplication.
- Document the CI entrypoints (GitHub Actions or another pipeline) that will run the above scripts, so deployment scaffolding (T37/T38) can wire the baseline checks without guessing what belongs in T00.
