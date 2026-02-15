# AGENTS.md (apps/cli/src)

## Purpose
- Keep CLI source modules small, composable, and safe for local operator workflows.

## Command Modules
- Keep each command implementation in `commands/<name>.ts` with one exported factory (`create<Name>Command`).
- Reuse shared command wrappers (`withErrorHandling`) and IO helpers (`writeStdoutLine`, `writeStderrLine`) instead of inline process writes.
- Prefer explicit error-to-reason mapping for operator-facing failures rather than generic stack traces.
- Prefer SDK shared primitives (`AppError`, `nowIso`) for new command error/date logic instead of ad-hoc equivalents.

## Verification Flow Contract
- `verify` must support both raw token input and file-path input without requiring extra flags.
- Resolve registry material from configured `registryUrl` only (`/.well-known/claw-keys.json`, `/v1/crl`).
- Use cached key/CRL artifacts only when fresh and scoped to the same registry URL.
- Treat CRL refresh/validation failures as hard verification failures (fail-closed behavior).

## Caching Rules
- Cache reads must be tolerant of malformed JSON by ignoring bad cache and fetching fresh data.
- Cache writes must use restrictive permissions through config-manager helpers.
- Cache payloads must be JSON and include `fetchedAtMs` timestamps for TTL checks.

## Testing Rules
- Command tests must capture `stdout`/`stderr` and assert exit-code behavior.
- Include success, revoked, invalid token, keyset failure, CRL failure, and cache-hit scenarios for `verify`.
- For OpenClaw invite/setup flow, cover invite encode/decode, config patch idempotency, and missing-file validation.
- Keep tests deterministic by mocking network and filesystem dependencies.
