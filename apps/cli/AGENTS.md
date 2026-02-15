# AGENTS.md (apps/cli)

## Purpose
- Define conventions for the `clawdentity` CLI package.
- Keep command behavior predictable, testable, and safe for local credential storage.

## Command Architecture
- Keep `src/index.ts` as a pure program builder (`createProgram()`); no side effects on import.
- Keep `src/bin.ts` as a thin runtime entry only (`parseAsync` + top-level error handling).
- Implement command groups under `src/commands/*` and register them from `createProgram()`.
- Reuse shared command helpers from `src/commands/helpers.ts` (especially `withErrorHandling`) instead of duplicating command-level try/catch blocks.
- Use `process.exitCode` instead of `process.exit()`.
- Use `@clawdentity/sdk` `createLogger` for runtime logging; avoid direct `console.*` calls in CLI app code.
- Keep user-facing command output on `writeStdoutLine` / `writeStderrLine`; reserve structured logger calls for diagnostic events.

## Config and Secrets
- Local CLI config lives at `~/.clawdentity/config.json`.
- Agent identities live at `~/.clawdentity/agents/<name>/` and must include `secret.key`, `public.key`, `identity.json`, and `ait.jwt`.
- Resolve values with explicit precedence: environment variables > config file > built-in defaults.
- Keep API tokens masked in human-facing output (`show`, success logs, debug prints).
- Write config and identity artifacts with restrictive permissions (`0600`) and never commit secrets or generated local config.

## Testing Rules
- Use Vitest for all tests.
- Unit-test config I/O and precedence logic with mocked `node:fs/promises` and `node:os`.
- Command tests should assert both behavior and output by capturing `process.stdout.write` / `process.stderr.write`.
- Cover invalid input and failure paths, not only happy paths.

## Validation Commands
- `pnpm -F @clawdentity/cli lint`
- `pnpm -F @clawdentity/cli typecheck`
- `pnpm -F @clawdentity/cli test`
- `pnpm -F @clawdentity/cli build`
- For cross-package changes, run root checks: `pnpm lint`, `pnpm -r typecheck`, `pnpm -r test`, `pnpm -r build`.

## Refactor Trigger
- If command count grows, move to a typed command registry/builder so command wiring stays declarative and avoids duplicate validation/output code.
