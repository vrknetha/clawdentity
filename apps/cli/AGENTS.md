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
- Prefer `@clawdentity/sdk` helpers (`decodeAIT`) when surfacing agent metadata instead of parsing JWTs manually.
 - Reject agent names that are only `.` or `..` before resolving directories or files to prevent accidental traversal of home config directories.

## Config and Secrets
- Local CLI config lives at `~/.clawdentity/config.json`.
- Agent identities live at `~/.clawdentity/agents/<name>/` and must include `secret.key`, `public.key`, `identity.json`, and `ait.jwt`.
- Reject `.` and `..` as agent names before any filesystem operation to prevent directory traversal outside `~/.clawdentity/agents/`.
- Resolve values with explicit precedence: environment variables > config file > built-in defaults.
- Keep API tokens masked in human-facing output (`show`, success logs, debug prints).
- Write config and identity artifacts with restrictive permissions (`0600`) and never commit secrets or generated local config.

## Testing Rules
- Use Vitest for all tests.
- Unit-test config I/O and precedence logic with mocked `node:fs/promises` and `node:os`.
- Command tests should assert both behavior and output by capturing `process.stdout.write` / `process.stderr.write`.
- Cover invalid input and failure paths, not only happy paths.

## Agent Inspection
- `agent inspect <name>` reads `~/.clawdentity/agents/<name>/ait.jwt`, decodes it with `decodeAIT`, and prints DID, Owner, Expires, Key ID, Public Key, and Framework so operators can audit metadata offline.
- Surface user-friendly errors when the JWT is missing or cannot be decoded, mentioning `ait.jwt` explicitly and defaulting to the normalized agent name when validating input.
- Tests for new inspection behavior must mock `node:fs/promises.readFile` and `@clawdentity/sdk.decodeAIT`, assert the visible output, and confirm missing-file handling covers `ENOENT`.

## Validation Commands
- `pnpm -F @clawdentity/cli lint`
- `pnpm -F @clawdentity/cli typecheck`
- `pnpm -F @clawdentity/cli test`
- `pnpm -F @clawdentity/cli build`
- For cross-package changes, run root checks: `pnpm lint`, `pnpm -r typecheck`, `pnpm -r test`, `pnpm -r build`.

## Refactor Trigger
- If command count grows, move to a typed command registry/builder so command wiring stays declarative and avoids duplicate validation/output code.
