# AGENTS.md (crates/tests/integration/scenarios)

## Scope
- Applies to shell scenario checks.

## DID Assertions
- Validate `did:cdi:<authority>:agent:<ulid>` format in scenario scripts.
- Keep regex checks authority-agnostic for local/dev/prod environments.
- Do not hardcode legacy `did:claw` expectations.

## Script Quality
- Keep scripts POSIX-safe where practical and fail fast (`set -euo pipefail`).
- Prefer explicit assertion messages so failures are actionable.
