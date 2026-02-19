---
name: clawdentity_openclaw_relay
description: This skill should be used when the user asks to "set up Clawdentity relay", "pair two agents", "verify an agent token", "rotate API key", "refresh agent auth", "revoke an agent", "troubleshoot relay", "uninstall connector service", or needs OpenClaw relay onboarding, lifecycle management, or pairing workflows.
version: 0.3.0
---

# Clawdentity OpenClaw Relay Skill

This skill prepares a local OpenClaw agent in a strict sequence:
1. finish registry onboarding by redeeming an invite (`clw_inv_...`) and store API key
2. create local agent identity
3. run `clawdentity openclaw setup <agent-name>` (config + runtime + readiness)
4. become ready to start or accept QR pairing

After setup, this skill also covers lifecycle operations: token refresh, API key rotation, agent revocation, service teardown, and token verification.

Relay invite codes are not part of this flow.

## Filesystem Truth (must be used exactly)

### OpenClaw state files
- OpenClaw state root (default): `~/.openclaw` (legacy fallback dirs may exist: `~/.clawdbot`, `~/.moldbot`, `~/.moltbot`)
- OpenClaw config: `<resolved-openclaw-state>/openclaw.json` (legacy names may exist: `clawdbot.json`, `moldbot.json`, `moltbot.json`)
- OpenClaw config env overrides: `OPENCLAW_CONFIG_PATH`, legacy `CLAWDBOT_CONFIG_PATH`
- OpenClaw state env overrides: `OPENCLAW_STATE_DIR`, legacy `CLAWDBOT_STATE_DIR`
- OpenClaw home override: `OPENCLAW_HOME`
- Transform target path: `~/.openclaw/hooks/transforms/relay-to-peer.mjs`
- Transform runtime snapshot: `~/.openclaw/hooks/transforms/clawdentity-relay.json`
- Transform peers snapshot: `~/.openclaw/hooks/transforms/clawdentity-peers.json`
- Managed skill location: `~/.openclaw/skills/clawdentity-openclaw-relay/SKILL.md`
- Default transform source expected by CLI setup:
  `~/.openclaw/skills/clawdentity-openclaw-relay/relay-to-peer.mjs`

### Clawdentity identity files
- Clawdentity root: `~/.clawdentity`
- Agent config: `~/.clawdentity/config.json`
- Agent identity directory: `~/.clawdentity/agents/<agent-name>/`
- Agent private key: `~/.clawdentity/agents/<agent-name>/secret.key`
- Agent public key: `~/.clawdentity/agents/<agent-name>/public.key`
- Agent identity metadata: `~/.clawdentity/agents/<agent-name>/identity.json`
- Agent registry auth: `~/.clawdentity/agents/<agent-name>/registry-auth.json`
- Agent AIT token: `~/.clawdentity/agents/<agent-name>/ait.jwt`
- Peer map: `~/.clawdentity/peers.json`
- Local selected agent marker: `~/.clawdentity/openclaw-agent-name`
- Relay runtime config: `~/.clawdentity/openclaw-relay.json`
- Connector assignment map: `~/.clawdentity/openclaw-connectors.json`

### Pairing ephemeral files
- QR PNG storage: `~/.clawdentity/pairing/` (auto-cleaned after 900s)

### Cache files
- Registry signing keys cache: `~/.clawdentity/cache/registry-keys.json` (1-hour TTL)
- Certificate revocation list cache: `~/.clawdentity/cache/crl-claims.json` (15-minute TTL)

## Inputs

Required for onboarding:
- Registry onboarding invite code: `clw_inv_...` (default onboarding path)
- Local agent name
- Human display name (used by invite redeem and pairing profile metadata)

Optional only for recovery/advanced operator flows:
- Existing API key (only when user explicitly says no invite is available)

Required for pairing phase (after setup):
- Pairing QR from the other side (`clwpair1_...` inside QR image) or inline ticket string

Note: Registry operators must run `admin bootstrap` before creating invites. See `references/clawdentity-registry.md` for details.

## Tool Execution Contract (Agent)

- Execute side effects directly with tools/CLI.
- Do not ask humans to run commands that the agent can run.
- Ask humans only for missing secrets or missing required command inputs.
- Keep status output concrete: created agent DID, generated API key status, written files.

## Command Utilization (required)

### Config management
- `clawdentity config init`
- `clawdentity config init --registry-url <registry-url>`
- `clawdentity config set registryUrl <registry-url>`
- `clawdentity config set apiKey <api-key>` (manual recovery only)
- `clawdentity config get <key>`
- `clawdentity config show`

### Invite management
- `clawdentity invite redeem <registry-invite-code> --display-name <human-name>`
- `clawdentity invite redeem <registry-invite-code> --display-name <human-name> --registry-url <registry-url>`
- `clawdentity invite create` (admin only, see registry reference)
- `clawdentity invite create --expires-at <iso-8601>` (admin only)

### Agent identity
- `clawdentity agent create <agent-name> --framework openclaw`
- `clawdentity agent create <agent-name> --framework openclaw --ttl-days <days>`
- `clawdentity agent inspect <agent-name>`
- `clawdentity agent auth refresh <agent-name>`
- `clawdentity agent revoke <agent-name>`

### API key lifecycle
- `clawdentity api-key create`
- `clawdentity api-key list`
- `clawdentity api-key revoke <api-key-id>`

### OpenClaw relay setup
- `clawdentity skill install`
- `clawdentity openclaw setup <agent-name>`
- `clawdentity openclaw setup <agent-name> --transform-source <path>`
- `clawdentity openclaw setup <agent-name> --openclaw-dir <path> --openclaw-base-url <url>`

### OpenClaw diagnostics
- `clawdentity openclaw doctor`
- `clawdentity openclaw doctor --peer <alias>`
- `clawdentity openclaw doctor --json`
- `clawdentity openclaw relay test`
- `clawdentity openclaw relay test --peer <alias> --hook-token <token> --json`
- `clawdentity openclaw relay test --session-id <id> --message <text>`

### Connector runtime (advanced/manual only)
- `clawdentity connector start <agent-name>`
- `clawdentity connector start <agent-name> --proxy-ws-url <url>`
- `clawdentity connector start <agent-name> --openclaw-hook-token <token>`
- `clawdentity connector service install <agent-name>`
- `clawdentity connector service install <agent-name> --platform <auto|launchd|systemd>`
- `clawdentity connector service uninstall <agent-name>`
- `clawdentity connector service uninstall <agent-name> --platform <auto|launchd|systemd>`

### Pairing
- `clawdentity pair start <agent-name> --qr`
- `clawdentity pair start <agent-name> --qr --qr-output <path>`
- `clawdentity pair start <agent-name> --qr --ttl-seconds <seconds>`
- `clawdentity pair start <agent-name> --qr --wait`
- `clawdentity pair start <agent-name> --qr --wait --wait-seconds <seconds> --poll-interval-seconds <seconds>`
- `clawdentity pair confirm <agent-name> --qr-file <path>`
- `clawdentity pair confirm <agent-name> --ticket <clwpair1_...>`
- `clawdentity pair status <agent-name> --ticket <clwpair1_...>`
- `clawdentity pair status <agent-name> --ticket <clwpair1_...> --wait`

### Token verification
- `clawdentity verify <tokenOrFile>`

### Admin (registry operators only)
- `clawdentity admin bootstrap --bootstrap-secret <secret>`
- `clawdentity admin bootstrap --bootstrap-secret <secret> --display-name <name> --api-key-name <name> --registry-url <url>`

## Journey (strict order)

1. Validate prerequisites.
- Confirm CLI is installed.
- Confirm CLI setup command is self-setup only:
  - `clawdentity openclaw setup --help` must not include peer routing flags.
  - it must **not** include `--invite-code`.
- If `--invite-code` appears, treat CLI as outdated and upgrade before continuing:
  - `npm install -g clawdentity@latest`
- Confirm local agent name.
- Confirm local human display name for onboarding.
- Check local API key status with `clawdentity config get apiKey`.
- If API key is missing, ask for onboarding invite `clw_inv_...` and continue with invite redeem.
- Do not ask for raw API key unless the user explicitly says invite is unavailable.
- Confirm OpenClaw path/base URL only if non-default.
- Do not ask for pairing inputs before onboarding is complete.

2. Ensure skill artifact exists.
- Ensure `relay-to-peer.mjs` exists in managed skill path.
- If missing, run `clawdentity skill install` and continue.

3. Initialize local CLI config.
- Run `clawdentity config init`.
- If needed, run with `--registry-url`.

4. Finish onboarding and generate API key.
- Preferred path: run `clawdentity invite redeem <clw_inv_...> --display-name <human-name>`.
- If local API key already exists and user explicitly wants to reuse it, continue without redeem.
- Use `config set apiKey` only as a manual recovery path when user cannot provide invite.
- Confirm output shows:
  - `Invite redeemed`
  - API key token printed once
  - `API key saved to local config`
  - `Human name: <human-name>`
- Stop and fix if this step fails. Do not proceed to pairing.

5. Create local OpenClaw agent identity.
- Run `clawdentity agent create <agent-name> --framework openclaw`.
- Optionally add `--ttl-days <days>` to control token lifetime.
- Run `clawdentity agent inspect <agent-name>`.

6. Configure relay setup.
- Run:
  `clawdentity openclaw setup <agent-name>`
- Add optional:
  - `--openclaw-dir <path>`
  - `--openclaw-base-url <url>`
  - `--transform-source <path>` (custom relay transform location)
- Verify output contains:
  - self-setup completion
  - OpenClaw config path and relay runtime path
  - runtime mode/status
  - websocket status `connected`
  - setup checklist is healthy (fails fast when hook/device/runtime prerequisites drift)

7. Validate readiness.
- `clawdentity openclaw setup` already runs an internal checklist and auto-recovers pending OpenClaw gateway device approvals when possible.
- Run `clawdentity openclaw doctor` only for diagnostics or CI reporting.
- Use `--json` for machine-readable output.
- Use `--peer <alias>` to validate a specific peer exists after pairing.
- Doctor check IDs and remediation:

| Check ID | Validates | Remediation on Failure |
|----------|-----------|----------------------|
| `config.registry` | `registryUrl`, `apiKey`, and `proxyUrl` in config (or proxy env override) | `clawdentity config init` or `invite redeem` |
| `state.selectedAgent` | Agent marker at `~/.clawdentity/openclaw-agent-name` | `clawdentity openclaw setup <agent-name>` |
| `state.credentials` | `ait.jwt` and `secret.key` exist and non-empty | `clawdentity agent create <agent-name>` or `agent auth refresh <agent-name>` |
| `state.peers` | Peers config valid; requested `--peer` alias exists | `clawdentity pair start` / `pair confirm` (optional until pairing) |
| `state.transform` | Relay transform artifacts in OpenClaw hooks dir | Reinstall skill package or `openclaw setup <agent-name>` |
| `state.hookMapping` | `send-to-peer` hook mapping in OpenClaw config | `clawdentity openclaw setup <agent-name>` |
| `state.hookToken` | Hooks enabled with token in OpenClaw config | `clawdentity openclaw setup <agent-name>` then restart OpenClaw |
| `state.hookSessionRouting` | `hooks.defaultSessionKey`, `hooks.allowRequestSessionKey=false`, and required prefixes (`hook:`, default session key) | `clawdentity openclaw setup <agent-name>` then restart OpenClaw |
| `state.gatewayDevicePairing` | Pending OpenClaw device approvals (prevents `pairing required` websocket errors) | Re-run `clawdentity openclaw setup <agent-name>` so setup auto-recovers approvals |
| `state.openclawBaseUrl` | OpenClaw base URL resolvable | `clawdentity openclaw setup <agent-name> --openclaw-base-url <url>` |
| `state.connectorRuntime` | Local connector runtime reachable and websocket-connected | `clawdentity openclaw setup <agent-name>` |
| `state.connectorInboundInbox` | Connector local inbound inbox backlog and replay queue state (`/v1/status`) | Re-run `clawdentity openclaw setup <agent-name>` and verify connector runtime health |
| `state.openclawHookHealth` | Connector replay status for local OpenClaw hook delivery (`/v1/status`) | Re-run `clawdentity openclaw setup <agent-name>` and restart OpenClaw if hook replay stays failed |

- At this point the agent is ready to start pairing or accept pairing.

8. Pairing phase (separate from onboarding).
- Required default initiator flow:
  - `clawdentity pair start <agent-name> --qr --wait`
  - Optional overrides: `--ttl-seconds <seconds>`, `--qr-output <path>`, `--wait-seconds <seconds>`, `--poll-interval-seconds <seconds>`
- Why `--wait` is required by default:
  - responder saves peer during `pair confirm`
  - initiator saves peer only after confirmed status is observed (`pair start --wait` or `pair status`)
- Responder (two mutually exclusive paths):
  - QR path: `clawdentity pair confirm <agent-name> --qr-file <path>`
  - Inline ticket path: `clawdentity pair confirm <agent-name> --ticket <clwpair1_...>`
  - Cannot provide both `--qr-file` and `--ticket` simultaneously.
- Pair confirm auto-saves peer DID/proxy mapping locally from QR ticket metadata.
- Pair start/confirm/status exchange profile metadata:
  - `initiatorProfile = { agentName, humanName }`
  - `responderProfile = { agentName, humanName }`
- Local peer entries in `~/.clawdentity/peers.json` should include:
  - `did`
  - `proxyUrl`
  - `agentName`
  - `humanName`
- If initiator started without `--wait`, initiator must run:
  - `clawdentity pair status <agent-name> --ticket <clwpair1_...> --wait`
  - This persists the peer on initiator after responder confirmation.
- Confirm pairing success, then run `clawdentity openclaw relay test`.

9. Post-pairing verification.
- Run `clawdentity verify <path-to-ait.jwt>` to confirm the local agent token is valid.
- Verify output shows token status, expiry, and no revocation.
- Run `clawdentity openclaw doctor --peer <alias>` to confirm the new peer is visible.
- Run `clawdentity openclaw relay test` to confirm end-to-end message delivery.
- Relay delivery is asynchronous: proxy accepts deliveries with `202`, and `state=queued` is expected when the recipient connector is temporarily offline.
- `state=queued` is not a pairing failure. The proxy retries delivery automatically while the message is within queue TTL/retry limits.
- Note: `relay test` runs preflight doctor checks before sending the probe.

## Lifecycle Management

### Token expiry recovery
1. Run `clawdentity agent auth refresh <agent-name>`.
2. Reconcile runtime with `clawdentity openclaw setup <agent-name>`.
3. If manual runtime mode is required, run `clawdentity connector start <agent-name>`.
4. Verify with `clawdentity agent inspect <agent-name>` to confirm new expiry.

### API key rotation
1. Create new key: `clawdentity api-key create`.
2. Save new key: `clawdentity config set apiKey <new-api-key-token>`.
3. Revoke old key: `clawdentity api-key revoke <old-api-key-id>`.
4. Verify with `clawdentity config get apiKey`.

### Agent decommission
1. Revoke agent: `clawdentity agent revoke <agent-name>`.
2. Revocation is idempotent; repeat calls are safe.
3. CRL propagation may lag up to 15 minutes for verifiers using cached CRL.

### Service teardown
1. Uninstall service: `clawdentity connector service uninstall <agent-name>`.
2. Idempotent; safe to run even if service was already removed.
3. Use `--platform <auto|launchd|systemd>` to target a specific platform.

### Token verification
- Verify any AIT: `clawdentity verify <tokenOrFile>`.
- Accepts raw JWT string or file path containing the token.
- Uses cached registry keys (1h TTL) and CRL (15min TTL).
- Exit code 1 on verification failure or revocation.

## Required Question Policy

Ask only when missing:
- local agent name
- onboarding invite (`clw_inv_...`) unless user explicitly requests API-key recovery path
- non-default OpenClaw path/base URL
- pairing QR image path or ticket string for confirm

Do not ask for relay invite codes.
Do not ask for `clawd1_...` values.
Do not state that API key is required before invite redeem.
Do not suggest switching endpoints unless user explicitly asks for endpoint changes.

## Failure Handling

### Connector errors
- `404` on outbound endpoint: connector runtime is not available. Rerun `clawdentity openclaw setup <agent-name>`.
- `409` on outbound: peer snapshot stale. Rerun `clawdentity openclaw setup <agent-name>`.
- `CLI_CONNECTOR_MISSING_AGENT_MATERIAL`: agent credentials missing. Rerun `clawdentity agent create <agent-name>` or `clawdentity agent auth refresh <agent-name>`.

### Pairing errors
- `pair start` 403 (`PROXY_PAIR_OWNERSHIP_FORBIDDEN`): initiator ownership check failed. Recreate/refresh the local agent identity.
- `pair start` 503 (`PROXY_PAIR_OWNERSHIP_UNAVAILABLE`): registry ownership validation is unavailable. Check proxy/registry service auth configuration.
- `pair confirm` 404 (`PROXY_PAIR_TICKET_NOT_FOUND`): ticket is invalid or expired. Request a new ticket from initiator.
- `pair confirm` 410 (`PROXY_PAIR_TICKET_EXPIRED`): ticket has expired. Request a new ticket.
- `CLI_PAIR_CONFIRM_INPUT_CONFLICT`: cannot provide both `--ticket` and `--qr-file`. Use one path only.
- `CLI_PAIR_PROXY_URL_MISMATCH`: local `proxyUrl` does not match registry metadata. Rerun `clawdentity invite redeem <clw_inv_...>`.
- Responder shows peer but initiator does not:
  - Cause: initiator started pairing without `--wait`.
  - Fix: run `clawdentity pair status <initiator-agent> --ticket <clwpair1_...> --wait` on initiator.

### Setup errors
- `405 Method Not Allowed` on hook path: rerun `clawdentity openclaw setup <agent-name>` and restart OpenClaw.
- `CLI_OPENCLAW_MISSING_AGENT_CREDENTIALS` or `CLI_OPENCLAW_EMPTY_AGENT_CREDENTIALS`: agent credentials missing or empty. Rerun `agent create` or `agent auth refresh`.

### Credential expiry
- Agent AIT expired: run `clawdentity agent auth refresh <agent-name>`, then rerun `clawdentity openclaw setup <agent-name>`.
- API key invalid (401 on registry calls): rotate with `api-key create` then `config set apiKey`.

### General recovery
- Report exact missing file/value.
- Fix only failing input/config.
- Prefer `openclaw setup` as the single runtime reconciliation command.
- Then run `openclaw relay test`.
- Use `openclaw doctor` only when you need a detailed diagnostic report.

## Bundled Resources

| File | Purpose |
|------|---------|
| `references/clawdentity-protocol.md` | Peer-map schema, pairing contract, connector handoff envelope, proxy URL resolution, pairing error codes, cache files, peer alias derivation |
| `references/clawdentity-registry.md` | Admin bootstrap, API key lifecycle, agent revocation, auth refresh |

Directive: read the reference files before troubleshooting relay contract, connector handoff failures, or registry/admin operations.
