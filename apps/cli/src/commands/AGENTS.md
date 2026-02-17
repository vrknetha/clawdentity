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
- `openclaw setup` must persist/update `~/.clawdentity/openclaw-relay.json` with the resolved `openclawBaseUrl` so downstream proxy runtime can boot without manual env edits.
- `openclaw setup --openclaw-base-url` should only be needed when OpenClaw is not reachable on the default `http://127.0.0.1:18789`.
- `openclaw setup` must set `hooks.allowRequestSessionKey=false` by default and retain `hooks.allowedSessionKeyPrefixes` enforcement for safer `/hooks/agent` session routing.
- Keep thrown command errors static (no interpolated runtime values); include variable context in error details/log fields. Diagnostic check output (`openclaw doctor`, `openclaw relay test`) may include concrete paths/aliases so operators can remediate quickly.

## Connector Command Rules
- `connector start <agentName>` is the runtime entrypoint for local relay handoff and must remain long-running when connector runtime provides a wait/closed primitive.
- Validate agent local state before start (`identity.json`, `ait.jwt`, `secret.key`, `registry-auth.json`) and fail early with deterministic operator-facing errors.
- Keep connector startup wiring behind dependency-injected helpers so tests can mock module loading/runtime behavior without requiring a live connector package.
- Print resolved outbound endpoint and proxy websocket URL (when provided by runtime) so operators can verify local handoff and upstream connectivity.
- Parse and forward optional `registry-auth.json` expiry metadata (`accessExpiresAt`, `refreshExpiresAt`, `tokenType`) to connector runtime so startup refresh decisions can be made without re-reading CLI-side files.
- `connector service install <agentName>` must generate deterministic user-service files and wire autostart using OS-native tooling (`launchctl` or `systemctl --user`).
- `connector service install/uninstall` must keep service names/path generation stable from agent name so support/debug commands remain predictable.
- `connector service uninstall` must be safe to re-run (ignore already-stopped service errors and still remove service file).

## Registry Invite Command Rules
- `invite create` is for registry onboarding invites only (admin-authenticated), not peer-relay invite-code generation.
- `invite create` must call `INVITES_PATH` from `@clawdentity/protocol` and include PAT bearer auth from resolved CLI config.
- `invite redeem` must call `INVITES_REDEEM_PATH` from `@clawdentity/protocol` without PAT auth and must persist returned PAT to local config.
- `invite redeem` must print the plaintext PAT token once before config persistence so operators can recover from local write failures.
- Keep registry invite error mapping stable for `400`, `401`, `403`, `404`, `409`, and `5xx` responses.

## Admin Command Rules
- `admin bootstrap` must call registry `/v1/admin/bootstrap` with `x-bootstrap-secret` and fail with stable CLI error codes/messages.
- `admin bootstrap` must import `ADMIN_BOOTSTRAP_PATH` from `@clawdentity/protocol` instead of duplicating endpoint literals in command code/tests.
- Treat bootstrap API key token as write-once secret: print once, persist via config manager, and never log token contents.
- Normalize registry URL through URL parsing before requests; reject invalid URLs before network calls.
- Persist bootstrap output in deterministic order: `registryUrl` then `apiKey`, so CLI state is predictable after onboarding.
- Config persistence failures after successful bootstrap must not hide the returned PAT token; print token first, then surface recovery instructions.

## API Key Command Rules
- `api-key create` must call registry `POST /v1/me/api-keys` and print the plaintext PAT token once without persisting it into local config automatically.
- `api-key list` must call registry `GET /v1/me/api-keys` and print metadata only (`id`, `name`, `status`, `createdAt`, `lastUsedAt`), never token/hash/prefix values.
- `api-key revoke` must call registry `DELETE /v1/me/api-keys/:id` using ULID path validation before network calls.
- Keep API-key command error mapping stable for `401`, `400`, `404`, and `5xx` responses so rotation workflows are deterministic for operators.

## Agent Command Rules
- `agent create` must use a two-step registration handshake: request challenge from registry, sign canonical challenge message locally with agent private key, then submit registration with `challengeId` + `challengeSignature`.
- `agent create` must persist returned `agentAuth` bootstrap credentials to `registry-auth.json` alongside `identity.json`, `secret.key`, `public.key`, and `ait.jwt`.
- `agent auth refresh` must call `AGENT_AUTH_REFRESH_PATH` from `@clawdentity/protocol` using Claw + PoP headers and local refresh token payload, and PoP signing must use the resolved request path (including any registry base path prefix).
- `agent auth refresh` should call the shared SDK refresh client (`refreshAgentAuthWithClawProof`) so refresh request signing/error mapping stays consistent with runtime integrations.
- `agent auth refresh` must rewrite `registry-auth.json` atomically on success and keep error mapping stable for `400`, `401`, `409`, and `5xx`.
- Never send or log agent private keys; only send public key and proof signature.
- Keep proof canonicalization sourced from `@clawdentity/protocol` helper exports to avoid CLI/registry signature drift.
- Keep registry error mapping stable for both challenge and register requests so users receive deterministic remediation output.

## Testing Rules
- Mock network and filesystem dependencies in command tests.
- Include success and failure scenarios for external calls, parsing, and cache behavior.
- Assert exit code behavior in addition to stdout/stderr text.

## OpenClaw Diagnostic Command Rules
- `openclaw doctor` must stay read-only and validate required local state: resolved CLI config (`registryUrl` + `apiKey`), selected agent marker, local agent credentials, peers map integrity (and requested `--peer` alias), transform presence, hook mapping, and OpenClaw base URL resolution.
- `openclaw doctor` must print deterministic check IDs and actionable fix hints for each failed check.
- `openclaw doctor --json` must emit a stable machine-readable envelope with overall status + per-check results for CI scripting.

## OpenClaw Relay Test Command Rules
- `openclaw relay test --peer <alias>` must run doctor-style preflight checks before sending the probe payload.
- Relay probe must target local OpenClaw `POST /hooks/send-to-peer` with deterministic payload fields (`peer`, `sessionId`, `message`).
- Relay test output must summarize endpoint, HTTP status, and remediation guidance when delivery fails.
- `openclaw relay test --json` must emit a stable result envelope and include preflight details when preflight failed.
