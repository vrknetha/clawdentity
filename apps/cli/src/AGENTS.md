# AGENTS.md (apps/cli/src)

## Purpose
- Keep CLI source modules small, composable, and safe for local operator workflows.

## Command Modules
- Keep each command implementation in `commands/<name>.ts` with one exported factory (`create<Name>Command`).
- Reuse shared command wrappers (`withErrorHandling`) and IO helpers (`writeStdoutLine`, `writeStderrLine`) instead of inline process writes.
- Prefer explicit error-to-reason mapping for operator-facing failures rather than generic stack traces.
- Prefer SDK shared primitives (`AppError`, `nowIso`) for new command error/date logic instead of ad-hoc equivalents.
- Admin bootstrap command logic should stay in `commands/admin.ts` and remain side-effect-safe: only mutate config after a validated successful registry response.
- Admin bootstrap must print the one-time PAT before attempting to persist it and depend on `persistBootstrapConfig` so config write failures are surfaced via CLI errors while the operator still sees the PAT.
- API-key lifecycle command logic should stay in `commands/api-key.ts`; keep create/list/revoke request mapping explicit and keep token exposure limited to create output only.
- Connector runtime command logic should stay in `commands/connector.ts`; keep startup orchestration deterministic and avoid embedding connector runtime implementation details in the CLI.
- Keep connector runtime import bundled at build time (from `@clawdentity/connector`) so published `clawdentity` installs do not depend on unpublished workspace runtime packages.
- Registry invite lifecycle command logic should stay in `commands/invite.ts`; keep it strictly scoped to registry onboarding invites and separate from `commands/openclaw.ts` peer-relay invite codes.
- `invite redeem` must print the returned PAT once, then persist config in deterministic order (`registryUrl`, then `apiKey`) so bootstrap/onboarding state is predictable.
- `invite` command routes must use endpoint constants from `@clawdentity/protocol` (`INVITES_PATH`, `INVITES_REDEEM_PATH`) instead of inline path literals.
- Agent auth refresh state is stored per-agent at `~/.clawdentity/agents/<name>/registry-auth.json` and must be written with secure file permissions.
- `agent auth refresh` must use `Authorization: Claw <AIT>` + PoP headers from local agent keys and must not require PAT config.
- `pair` command logic should stay in `commands/pair.ts`; keep proxy pairing bootstrap (`/pair/start`, `/pair/confirm`) CLI-driven with local AIT + PoP proof headers and one-time ticket QR support (`--qr`, `--qr-file`).
- `connector start <agentName>` must validate local agent material (`identity.json`, `ait.jwt`, `secret.key`, `registry-auth.json`) before starting runtime and must fail with stable CLI errors when files are missing/invalid.
- `connector start` must print the local outbound handoff endpoint so transform troubleshooting is deterministic.
- `connector service install <agentName>` must install user-scoped autostart integration (`launchd` on macOS, `systemd --user` on Linux) so connector runtime survives host restarts.
- `connector service uninstall <agentName>` must be idempotent and remove the generated service file even when the service is already stopped/unloaded.

## Skill Install Mode
- Keep npm skill-install logic in shared helpers (`install-skill-mode.ts`) and invoke it from `postinstall.ts`; do not embed installer logic inside command factories.
- Detect install mode via npm environment (`npm_config_skill` and npm argv fallback) so non-skill installs remain unaffected.
- Resolve skill artifacts in this order: explicit override, bundled `skill-bundle/openclaw-skill`, installed `@clawdentity/openclaw-skill`, then workspace fallback.
- Skill install must copy `SKILL.md`, `references/*`, and `relay-to-peer.mjs` into OpenClaw runtime paths under `~/.openclaw` and must fail with actionable errors when source artifacts are missing.
- Installer logs must be deterministic and explicit (`installed`, `updated`, `unchanged`) so automated skill tests can assert outcomes reliably.
- Keep installer tests independent from repo-committed bundle artifacts by using sandbox roots and `CLAWDENTITY_SKILL_PACKAGE_ROOT` overrides where needed.

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
- For registry invite flow, cover admin-auth create path, public redeem path, config persistence failures, and command exit-code behavior.
- Keep tests deterministic by mocking network and filesystem dependencies.
