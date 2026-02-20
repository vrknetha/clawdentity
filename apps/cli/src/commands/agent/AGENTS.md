# AGENTS.md (agent command modules)

## Purpose
- Keep agent command code modular, testable, and behavior-stable.
- Preserve CLI output/error behavior and existing `agent` test expectations.

## Module Boundaries
- `types.ts`: shared agent command data contracts only.
- `paths.ts`: all agent file-name constants and local path resolution.
- `validation.ts`: input parsing/validation, DID parsing, response parsing, and shared formatting helpers.
- `fs.ts`: local identity/auth file reads and secure writes.
- `registry.ts`: registry HTTP URL builders, challenge/register/revoke requests, and HTTP error mapping.
- `auth.ts`: registry-auth refresh orchestration via shared SDK client.
- `command.ts`: Commander wiring and stdout formatting only.
- `../agent.ts`: thin public facade exporting `createAgentCommand`.

## Guardrails
- Keep every source file under 800 LOC.
- Avoid circular imports across `paths.ts`, `validation.ts`, `fs.ts`, `registry.ts`, `auth.ts`, and `command.ts`.
- Keep user-facing error strings stable unless tests and issue scope require a change.
- Keep command stdout wording/order stable; tests depend on deterministic output.
- Reuse helpers instead of duplicating path parsing, JSON parsing, or registry error mapping.
- Keep agent private key material local-only; never log or send private key values.

## Change Workflow
- Add/update tests in `apps/cli/src/commands/agent.test.ts` when behavior changes.
- Run validations before handoff:
  - `pnpm -C apps/cli typecheck`
  - `pnpm -C apps/cli test -- agent`
  - `pnpm lint`
