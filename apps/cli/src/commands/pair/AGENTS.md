# AGENTS.md (pair command modules)

## Purpose
- Keep pairing command code modular, testable, and behavior-stable.
- Preserve CLI output/error behavior and existing pair test expectations.

## Module Boundaries
- `types.ts`: shared pair option/result/dependency contracts only.
- `common.ts`: pair constants, logger, validation/parsing helpers, and shared pure utilities.
- `proxy.ts`: proxy URL resolution, signed request helpers, API response parsing, and proxy error mapping.
- `persistence.ts`: peer map persistence and OpenClaw relay peer-snapshot sync.
- `qr.ts`: QR encode/decode, stale QR cleanup, and ticket-source resolution.
- `service.ts`: start/confirm/status orchestration.
- `command.ts`: Commander wiring and stdout formatting only.
- `../pair.ts`: thin public facade and stable exports.

## Guardrails
- Keep each source file under 800 LOC.
- Avoid circular imports between `common.ts`, `proxy.ts`, `persistence.ts`, `qr.ts`, and `service.ts`.
- Keep pair error codes/messages stable; tests rely on deterministic behavior.
- Keep command stdout wording/order stable unless tests and scope require a change.
- Prefer helper reuse over duplicating ticket/profile/proxy parsing logic.

## Change Workflow
- Add/update pair tests in `apps/cli/src/commands/pair.test.ts` with behavior changes.
- Run validation before handoff:
  - `pnpm -C apps/cli typecheck`
  - `pnpm -C apps/cli test -- pair`
  - `pnpm lint`
