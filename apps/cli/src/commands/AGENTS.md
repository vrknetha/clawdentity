# AGENTS.md (apps/cli/src/commands)

## Purpose
- Define implementation guardrails for individual CLI command modules.

## Command Patterns
- Export one command factory per file (`create<Name>Command`).
- Keep command handlers focused on orchestration; move reusable logic into local helpers.
- Use `withErrorHandling` for command actions unless a command has a documented reason not to.
- Route all user-facing messages through `writeStdoutLine`/`writeStderrLine`.

## Verification Command Rules
- `verify` must preserve the `✅`/`❌` output contract with explicit reasons.
- Token argument can be either a raw token or file path; missing file paths should fall back to raw token mode.
- Signature and CRL validation must use SDK helpers (`verifyAIT`, `verifyCRL`), not local JWT cryptography code.
- Cache usage must enforce TTL and registry URL matching before reuse.

## Testing Rules
- Mock network and filesystem dependencies in command tests.
- Include success and failure scenarios for external calls, parsing, and cache behavior.
- Assert exit code behavior in addition to stdout/stderr text.
