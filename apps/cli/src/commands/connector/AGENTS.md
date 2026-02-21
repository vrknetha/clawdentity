# AGENTS.md (connector command modules)

## Purpose
- Keep connector command code modular, testable, and behavior-stable.
- Preserve CLI output/error behavior and existing connector test expectations.

## Module Boundaries
- `types.ts`: shared connector constants, options, dependency contracts, and result types only.
- `validation.ts`: connector AppError creation, input parsing, URL validation, and platform-option parsing.
- `config.ts`: environment/config resolution, connector assignment lookup, relay runtime config lookup, and outbound/proxy URL resolution.
- `credentials.ts`: required local credential-file reads and identity/registry-auth parsing.
- `runtime.ts`: connector package loading and runtime wait/result extraction helpers.
- `service.ts`: start/install/uninstall orchestration and service file generation.
- `command.ts`: Commander wiring and stdout formatting only.
- `../connector.ts`: thin public facade and stable exports.

## Guardrails
- Keep each source file under 800 LOC.
- Avoid circular imports across connector modules.
- Keep connector error codes/messages stable; tests and operator workflows rely on deterministic behavior.
- Keep command stdout wording/order stable unless tests and scope explicitly require changes.
- Reuse existing helpers rather than duplicating identity/auth/config parsing logic.
- Keep service name/path generation deterministic from `agentName` so install/uninstall is predictable.

## Change Workflow
- Add or update tests in `apps/cli/src/commands/connector.test.ts` for behavior changes.
- Run validation before handoff:
  - `pnpm -C apps/cli typecheck`
  - `pnpm -C apps/cli test -- connector`
