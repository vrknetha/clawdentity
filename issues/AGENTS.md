# AGENTS.md (issues folder)

## Purpose
- This folder contains implementation-ready issue specifications for the Clawdentity support plugin roadmap.
- Each issue must be decision-complete so an engineer can execute it without guessing scope or acceptance criteria.

## Required Issue Schema
Every `T*.md` file must include these sections in this order:
1. `## Goal`
2. `## In Scope`
3. `## Out of Scope`
4. `## Dependencies`
5. `## Execution Mode`
6. `## Parallel Wave`
7. `## Required Skills`
8. `## Deliverables`
9. `## Refactor Opportunities`
10. `## Definition of Done`
11. `## Validation Steps`

## Dependency Rules
- `Dependencies` must list only valid ticket IDs (`T00` format) that exist in this folder.
- `Dependencies` must include a `Blockers` line.
- Before marking an issue complete, validate that all blockers are resolved.
- Run `pnpm issues:validate` before closing deployment-gate tickets (`T37`, `T38`) or changing dependency/wave metadata.
- Do not reorder dependency logic without updating `EXECUTION_PLAN.md`.

## Deployment-First Rule
- `T00` scaffolds the workspace.
- `T37` and `T38` are deployment gate tickets.
- Feature tickets (`T01`-`T36`) must depend on `T38`.
- No feature implementation begins before `T38` is complete.

## Quality Rules
- Keep acceptance criteria unique and non-duplicative.
- Add at least one refactor opportunity, or explicitly state `None`.
- Add concrete validation commands with expected outcomes.
- Keep scope narrow: one issue should represent one coherent unit of delivery.

## Skill Rules
- Every issue must declare required skills.
- Use the defined defaults from `EXECUTION_PLAN.md` when no issue-specific override is needed.
- There is currently no dedicated `openclaw support-plugin` skill; use mapped fallback skills by issue group.

## Change Management
- If a dependency is ambiguous, preserve current dependency links and add a note in that issue.
- Prefer small, maintainable updates over broad speculative rewrites.
- If a change affects sequencing or parallel waves, update both the issue file and `EXECUTION_PLAN.md` in the same change.

## Audit Best Practices
- Confirm each feature ticket (`T01`-`T36`) lists `T38` under `Dependencies` and in the `Blockers` line; document any gaps before capturing new wave assignments.
- When sequencing or wave assignments evolve, update `EXECUTION_PLAN.md` in the same commit so the deployment-first narrative stays accurate and blockers remain visible to reviewers.
- Use `pnpm issues:validate` as the final audit step after editing any `issues/T*.md` file.
