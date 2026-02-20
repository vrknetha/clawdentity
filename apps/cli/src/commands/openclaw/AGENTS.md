# AGENTS.md (openclaw command modules)

## Purpose
- Keep OpenClaw command code modular, testable, and behavior-stable.
- Preserve CLI output/error behavior unless explicitly requested by a tracked issue.

## Module Boundaries
- `types.ts`: shared type contracts only.
- `constants.ts`: string constants, defaults, hints, and logger.
- `common.ts`: validation/parsing/error helpers and shared generic utilities.
- `paths.ts`: all filesystem/env path resolution logic.
- `state.ts`: JSON file IO + persisted runtime/peer/assignment config access.
- `gateway.ts`: OpenClaw gateway pending-device approval flow.
- `connector.ts`: connector runtime status/probing/runtime-start helpers.
- `config.ts`: OpenClaw config patching and hook/gateway auth normalization.
- `doctor*.ts`: doctor orchestration and check groups.
- `relay.ts`: relay probe and websocket diagnostics.
- `setup.ts`: invite encode/decode and setup orchestration.
- `command.ts`: commander wiring + stdout formatting calls.
- `../openclaw.ts`: thin public facade and stable exports.

## Guardrails
- Keep every source file under 800 LOC.
- Do not introduce circular imports.
- Put reusable logic in shared modules (`common.ts`, `state.ts`, `connector.ts`, `config.ts`) instead of duplicating.
- Keep error codes/messages and remediation hints stable; tests assert these flows.
- Keep command stdout wording and ordering stable unless tests and issue scope require change.

## Change Workflow
- When adding behavior, add/adjust tests in `apps/cli/src/commands/openclaw.test.ts` first or in the same change.
- Run targeted checks before handoff:
  - `pnpm -C apps/cli test -- openclaw`
  - `pnpm -C apps/cli typecheck`
  - `pnpm lint`
- If a helper is used by multiple domains, prefer promoting it to a shared module instead of cross-domain duplication.
