# AGENTS.md (apps/cli/src/commands)

## Purpose
- Define implementation guardrails for individual CLI command modules.

## Command Patterns
- Export one command factory per file (`create<Name>Command`).
- Keep command handlers focused on orchestration; move reusable logic into local helpers.
- Use `withErrorHandling` for command actions unless a command has a documented reason not to.
- Route all user-facing messages through `writeStdoutLine`/`writeStderrLine`.
- For new command-domain errors, use SDK `AppError` with stable `code` values.

## Verification Command Rules
- `verify` must preserve the `✅`/`❌` output contract with explicit reasons.
- Token argument can be either a raw token or file path; missing file paths should fall back to raw token mode.
- Signature and CRL validation must use SDK helpers (`verifyAIT`, `verifyCRL`), not local JWT cryptography code.
- Cache usage must enforce TTL and registry URL matching before reuse.

## OpenClaw Command Rules
- `openclaw invite` must generate self-contained invite code from admin-provided DID + proxy URL.
- `openclaw setup` must be idempotent for relay mapping updates and peer map writes.
- Keep error messages static (no interpolated runtime values); include variable context only in error details/log fields.

## Admin Command Rules
- `admin bootstrap` must call registry `/v1/admin/bootstrap` with `x-bootstrap-secret` and fail with stable CLI error codes/messages.
- Treat bootstrap API key token as write-once secret: print once, persist via config manager, and never log token contents.
- Normalize registry URL through URL parsing before requests; reject invalid URLs before network calls.
- Persist bootstrap output in deterministic order: `registryUrl` then `apiKey`, so CLI state is predictable after onboarding.

## Testing Rules
- Mock network and filesystem dependencies in command tests.
- Include success and failure scenarios for external calls, parsing, and cache behavior.
- Assert exit code behavior in addition to stdout/stderr text.
