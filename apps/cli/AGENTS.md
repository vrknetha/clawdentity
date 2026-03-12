# AGENTS.md (apps/cli)

## Purpose
- Define conventions for the `clawdentity` CLI package.
- This package is compatibility surface; canonical operator UX is the Rust CLI in `crates/clawdentity-cli`.
- Keep command behavior predictable, testable, and safe for local credential storage.

## Command Architecture
- Keep `src/index.ts` as a pure program builder (`createProgram()`); no side effects on import.
- Keep `src/bin.ts` as a thin runtime entry only (`parseAsync` + top-level error handling).
- Keep `src/postinstall.ts` as a no-op compatibility shim; skill installation is command-driven via `clawdentity skill install`.
- Keep `postinstall.mjs` fail-safe for source checkouts and CI: if `dist/postinstall.js` is absent, it must no-op and never fail `pnpm install`.
- Keep package identity clear: workspace package name is `clawdentity`.
- Keep runtime version parity: source `CLI_VERSION` from the package metadata (`package.json`) at runtime, never from a hardcoded literal in `src/index.ts`.
- Implement command groups under `src/commands/*` and register them from `createProgram()`.
- Keep top-level command contracts stable (`config`, `agent`, `admin`, `api-key`, `invite`, `verify`, `openclaw`, `connector`, `skill`) so automation and docs do not drift.
- Reuse shared command helpers from `src/commands/helpers.ts` (especially `withErrorHandling`) instead of duplicating command-level try/catch blocks.
- Use `process.exitCode` instead of `process.exit()`.
- Use `@clawdentity/sdk` `createLogger` for runtime logging; avoid direct `console.*` calls in CLI app code.
- Keep user-facing command output on `writeStdoutLine` / `writeStderrLine`; reserve structured logger calls for diagnostic events.
- Prefer `@clawdentity/sdk` helpers (`decodeAIT`) when surfacing agent metadata instead of parsing JWTs manually.
- Reject agent names that are only `.` or `..` before resolving directories or files to prevent accidental traversal of home config directories.
- Keep published CLI artifacts standalone-installable: bundle runtime imports into `dist/*` and avoid `workspace:*` runtime dependencies in published `package.json`.
- Keep publish artifacts ESM-compatible and avoid bundling CJS-only runtime deps that rely on dynamic `require` (for example `ws`); externalize them and declare them in CLI `dependencies` so installed binaries start cleanly.
- `skill install` behavior must be idempotent and deterministic: reruns should only report `installed`, `updated`, or `unchanged` per artifact with stable output ordering.
- Keep `skill-bundle/openclaw-skill/` generated from `apps/openclaw-skill` only; do not hand-edit bundled files.
- Keep generated bundle policy strict: `sync-skill-bundle` must copy from `apps/openclaw-skill/dist/relay-to-peer.mjs` and fail if source build artifacts are missing.
- Keep generated bundle files out of git; rely on `build`/`prepack` to rebuild `skill-bundle` before `npm pack`/`npm publish`.
- Keep `verify:skill-bundle` aligned with required install artifacts so CI validates tarball readiness before publish.
- Keep CLI tests independent from repo-committed bundle artifacts by using sandbox skill roots or explicit `CLAWDENTITY_SKILL_PACKAGE_ROOT` overrides.
- Keep runtime dependencies publish-safe: avoid `workspace:*` entries in published runtime deps (`dependencies`, `peerDependencies`, `optionalDependencies`), and bundle internal packages into CLI dist.
- Keep release automation in `.github/workflows/publish-cli.yml` manual-only with explicit semver input and npm provenance.

## Config and Secrets
- Local CLI state is registry-scoped and lives under:
  - `~/.clawdentity/states/prod/`
  - `~/.clawdentity/states/dev/`
  - `~/.clawdentity/states/local/`
- Active state routing hint is stored at `~/.clawdentity/router.json`; keep it machine-local and non-sensitive.
- Local CLI config lives at `~/.clawdentity/states/<state>/config.json`.
- CLI verification caches live under `~/.clawdentity/states/<state>/cache/` and must never include private keys or PATs.
- Agent identities live at `~/.clawdentity/states/<state>/agents/<name>/` and must include `secret.key`, `public.key`, `identity.json`, and `ait.jwt`.
- OpenClaw setup runtime hint lives at `~/.clawdentity/states/<state>/openclaw-relay.json` and stores `openclawBaseUrl` for proxy fallback.
- Connector runtime defaults to local outbound handoff endpoint `http://127.0.0.1:19400/v1/outbound`; keep transform and CLI defaults aligned.
- Reject `.` and `..` as agent names before any filesystem operation to prevent directory traversal outside `~/.clawdentity/states/<state>/agents/`.
- Resolve values with explicit precedence: environment variables > config file > built-in defaults.
- Keep API tokens masked in human-facing output (`show`, success logs, debug prints).
- Write config and identity artifacts with restrictive permissions (`0600`) and never commit secrets or generated local config.
- API-key lifecycle commands must print plaintext PATs only at creation time and never persist newly-created tokens automatically without explicit user action.

## Testing Rules
- Use Vitest for all tests.
- Unit-test config I/O and precedence logic with mocked `node:fs/promises` and `node:os`.
- Command tests should assert both behavior and output by capturing `process.stdout.write` / `process.stderr.write`.
- Cover invalid input and failure paths, not only happy paths.

## Agent Inspection
- `agent inspect <name>` reads `~/.clawdentity/states/<state>/agents/<name>/ait.jwt`, decodes it with `decodeAIT`, and prints DID, Owner, Expires, Key ID, Public Key, and Framework so operators can audit metadata offline.
- Surface user-friendly errors when the JWT is missing or cannot be decoded, mentioning `ait.jwt` explicitly and defaulting to the normalized agent name when validating input.
- Tests for new inspection behavior must mock `node:fs/promises.readFile` and `@clawdentity/sdk.decodeAIT`, assert the visible output, and confirm missing-file handling covers `ENOENT`.

## Agent Revocation
- `agent revoke <name>` accepts local agent name only, then resolves `~/.clawdentity/states/<state>/agents/<name>/identity.json` to load the DID and derive the registry ULID path parameter.
- Keep revoke flow name-first and filesystem-backed; do not require operators to pass raw ULIDs for locally managed identities.
- Use registry `DELETE /v1/agents/:id` with PAT auth, and print human-readable confirmation that includes agent name + DID.
- Keep error messaging explicit for missing/malformed `identity.json`, invalid DID data, missing API key, and registry/network failures.
- Tests for revoke must cover success/idempotent `204`, auth/config failures, missing/invalid identity metadata, and HTTP error mapping for `401/404/409`.

## Token Verification
- `verify <tokenOrFile>` accepts either a raw AIT token or a filesystem path to a file containing one token.
- Verification is fail-closed for revocation checks: if CRL cannot be fetched/validated and no fresh cache is available, command must fail.
- Verify flow must use SDK primitives (`verifyAIT`, `verifyCRL`) and registry endpoints (`/.well-known/claw-keys.json`, `/v1/crl`) instead of local JWT parsing.
- Keep user output explicit and command-like: successful checks print `✅ ...`; failed checks print `❌ <reason>` and set non-zero exit code.
- Cache files (`registry-keys.json`, `crl-claims.json`) should include source registry URL + fetch timestamp so stale or cross-environment cache reuse is avoided.

## Adding new commands
- Keep `src/index.ts` as the only place wiring command builders (`createAgentCommand`, `createConfigCommand`, etc.); register a future `createOpenClawCommand()` there so the CLI surface stays predictable for automation/docs.
- Implement invite/setup behavior inside `src/commands/openclaw.ts` and reuse `withErrorHandling` from `src/commands/helpers.ts` for every subcommand. Pull shared config/paths from `../config/manager.js` to preserve the existing precedence and secrets handling semantics.
- Any logic shared between invite and setup (validation, payload construction, output formatting) should live in a dedicated helper module such as `src/commands/openclaw/helpers.ts` or exported helpers inside `helpers.ts`, not duplicated in multiple `.ts` files.
- Mimic the test pattern in `src/commands/agent.test.ts`: mock `node:fs/promises`, `@clawdentity/sdk`, `resolveConfig()`, and `fetch`, register the command under a root `Command`, and capture `stdout`/`stderr` so you can assert visible output plus exit codes for success/failure paths.
- Favor exporting pure helper functions so invite/setup logic can be unit-tested without needing to run the full CLI parse flow if you need tighter coverage.

## Validation Commands
- `pnpm -F clawdentity lint`
- `pnpm -F clawdentity typecheck`
- `pnpm -F clawdentity test`
- `pnpm -F clawdentity build`
- For cross-package changes, run root checks: `pnpm lint`, `pnpm -r typecheck`, `pnpm -r test`, `pnpm -r build`.

## Refactor Trigger
- If command count grows, move to a typed command registry/builder so command wiring stays declarative and avoids duplicate validation/output code.
