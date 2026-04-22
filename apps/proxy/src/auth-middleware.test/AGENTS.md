# AGENTS.md (apps/proxy/src/auth-middleware.test)

## Purpose
- Keep auth-middleware tests modular, deterministic, and easy to extend.

## Test Layout
- `helpers.ts`: shared deterministic time constants and auth harness builders.
- `basic.test.ts`: baseline auth flow and pairing bootstrap access rules.
- `rotation.test.ts`: registry key/CRL key rotation behavior.
- `agent-access.test.ts`: `/hooks/message` and `/v1/relay/connect` access-token checks.
- `robustness.test.ts`: malformed/replay/revoked/expired/dependency-failure cases.

## Best Practices
- Keep each spec file below 800 lines.
- Reuse `createAuthHarness` and shared constants from `helpers.ts`; avoid duplicate setup.
- Preserve deterministic time behavior via `NOW_MS`/`NOW_SECONDS` from helpers.
- Keep assertions explicit for status code and error code in every negative-path test.
- Add new tests to the concern-specific file; only create a new file when concern boundaries become unclear.
