---
name: clawdentity_openclaw_relay
description: This skill should be used when the user asks to "set up Clawdentity relay", "pair two agents", "verify an agent token", "rotate API key", "refresh agent auth", "revoke an agent", "troubleshoot relay", "uninstall connector service", "check relay health", "run relay doctor", "test relay connection", "send relay test", "install relay skill", "bootstrap registry", "create onboarding invite", "decommission agent", or needs OpenClaw relay onboarding, lifecycle management, or pairing workflows.
version: 0.3.1
---

# Clawdentity OpenClaw Relay Skill

This skill prepares a local OpenClaw agent in a strict sequence:
1. finish registry onboarding by redeeming an invite (`clw_inv_...`) and store API key
2. create local agent identity
3. run `clawdentity openclaw setup <agent-name>` (config + runtime + readiness)
4. become ready to start or accept QR pairing

After setup, this skill also covers lifecycle operations: token refresh, API key rotation, agent revocation, service teardown, and token verification.

Relay invite codes are not part of this flow.

## State Discovery First (required before asking for onboarding inputs)

Always detect existing local state before asking for invite code, API key, or peer setup.

1. Resolve OpenClaw state root.
- Default: `~/.openclaw`
- Respect env overrides: `OPENCLAW_STATE_DIR`, legacy `CLAWDBOT_STATE_DIR`, `OPENCLAW_HOME`

2. Resolve Clawdentity state root using this order.
- Primary: `~/.clawdentity`
- Fallback: `<openclaw-state>/.clawdentity`

3. If fallback exists and primary is missing:
- Run all `clawdentity ...` commands with `HOME=<openclaw-state>` so CLI resolves the same state root as OpenClaw profile.

4. Run readiness probe before asking questions:
- `clawdentity openclaw doctor --json`

5. Behavior gate from doctor output:
- If doctor is healthy: do not ask for onboarding invite/API key; proceed directly with requested relay/pairing action.
- If doctor is unhealthy: ask only for the minimum missing input required by failed checks.

Never claim that no local relay setup exists until this discovery flow is complete.

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
- `clawdentity skill install --openclaw-dir <path>`
- `clawdentity skill install --skill-package-root <path>`
- `clawdentity skill install --json`
- `clawdentity openclaw setup <agent-name>`
- `clawdentity openclaw setup <agent-name> --transform-source <path>`
- `clawdentity openclaw setup <agent-name> --openclaw-dir <path> --openclaw-base-url <url>`
- `clawdentity openclaw setup <agent-name> --runtime-mode <auto|service|detached>`
- `clawdentity openclaw setup <agent-name> --wait-timeout-seconds <seconds>` (default 30)
- `clawdentity openclaw setup <agent-name> --no-runtime-start`

Use `--no-runtime-start` when the connector runs as a separate container or process.

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
- `clawdentity pair start <agent-name> --qr --allow-responder <did:cdi:<authority>:agent:...>`
- `clawdentity pair start <agent-name> --qr --callback-url <https://...>`
- `clawdentity pair confirm <agent-name> --qr-file <path>`
- `clawdentity pair confirm <agent-name> --ticket <clwpair1_...>`
- `clawdentity pair status <agent-name> --ticket <clwpair1_...>`
- `clawdentity pair status <agent-name> --ticket <clwpair1_...> --wait`
- `clawdentity pair recover <agent-name>`

### Token verification
- `clawdentity verify <tokenOrFile>`

### Admin (registry operators only)
- `clawdentity admin bootstrap --bootstrap-secret <secret>`
- `clawdentity admin bootstrap --bootstrap-secret <secret> --display-name <name> --api-key-name <name> --registry-url <url>`

### Command idempotency

| Command | Idempotent? | Note |
|---|---|---|
| `config init` | Yes | Safe to re-run |
| `invite redeem` | **No** | One-time; invite consumed on success |
| `agent create` | No | Fails if agent directory exists |
| `openclaw setup` | Yes | Primary reconciliation re-entry point |
| `skill install` | Yes | Reports: installed/updated/unchanged |
| `pair start` | No | Creates new ticket each time; old ticket expires |
| `pair confirm` | No | Ticket consumed on success |
| `connector service install` | Yes | Idempotent |
| `connector service uninstall` | Yes | Idempotent |

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
- Check existing relay state first using **State Discovery First** above.
- Check local API key status with `clawdentity config get apiKey` only after state root resolution is confirmed.
- If API key is missing and doctor indicates onboarding is incomplete, ask for onboarding invite `clw_inv_...` and continue with invite redeem.
- Do not ask for raw API key unless the user explicitly says invite is unavailable and onboarding invite cannot be provided.
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
- **Validate:** `clawdentity config get apiKey` returns a non-empty value.

5. Create local OpenClaw agent identity.
- Run `clawdentity agent create <agent-name> --framework openclaw`.
- Optionally add `--ttl-days <days>` to control token lifetime.
- Run `clawdentity agent inspect <agent-name>`.
- **Validate:** `~/.clawdentity/agents/<agent-name>/ait.jwt` and `secret.key` exist and are non-empty.

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
- **Validate:** run `clawdentity openclaw doctor --json` and confirm all check entries have `status: "pass"`. If any check has `status: "fail"`, use `checkId` to look up remediation in `references/clawdentity-protocol.md` § Doctor Check Reference.
- If setup throws `CLI_OPENCLAW_SETUP_CHECKLIST_FAILED`, parse `details.firstFailedCheckId` for targeted remediation.

7. Validate readiness.
- `clawdentity openclaw setup` already runs an internal checklist, stabilizes OpenClaw gateway auth token mode, and auto-recovers pending OpenClaw gateway device approvals when possible.
- Run `clawdentity openclaw doctor` only for diagnostics or CI reporting.
- Use `--json` for machine-readable output.
- Use `--peer <alias>` to validate a specific peer exists after pairing.
- Doctor check IDs and remediation are in `references/clawdentity-protocol.md` § Doctor Check Reference.
- At this point the agent is ready to start pairing or accept pairing.

8. Pairing phase (separate from onboarding).
- Prerequisites (must be satisfied before any `pair` command):
  - `humanName` must be set in local config. It is set automatically by `invite redeem --display-name`; if missing, set it with `clawdentity config set humanName <name>`. If absent, CLI fails with `CLI_PAIR_HUMAN_NAME_MISSING`.
  - Proxy URL is auto-resolved by CLI (env → config → registry metadata). Do not ask the user for a proxy URL.
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
  - `initiatorProfile = { agentName, humanName, proxyOrigin? }`
  - `responderProfile = { agentName, humanName, proxyOrigin? }`
  - These are NOT CLI flags. The CLI auto-constructs them from `config.humanName` and the `<agent-name>` argument. Do not pass or ask for these values.
- Local peer entries in `~/.clawdentity/peers.json` should include:
  - `did`
  - `proxyUrl`
  - `agentName`
  - `humanName`
- If initiator started without `--wait`, initiator must run:
  - `clawdentity pair status <agent-name> --ticket <clwpair1_...> --wait`
  - This persists the peer on initiator after responder confirmation.
- Default wait timeout is 300 seconds with 3-second polling.
- Wait flow is resilient (adaptive polling + transient retries) and persists pending ticket state per agent.
- If wait times out/cancels/fails due repeated transients, preferred recovery is:
  - `clawdentity pair recover <agent-name>`
- Manual fallback remains:
  - `clawdentity pair status <agent-name> --ticket <clwpair1_...> --wait`
- Confirm pairing success, then run `clawdentity openclaw relay test`.
- **Validate:** `~/.clawdentity/peers.json` contains the new peer alias entry.

9. Post-pairing verification.
- Run `clawdentity verify <path-to-ait.jwt>` to confirm the local agent token is valid.
- Verify output shows token status, expiry, and no revocation.
- Run `clawdentity openclaw doctor --peer <alias>` to confirm the new peer is visible.
- Run `clawdentity openclaw relay test` to confirm end-to-end message delivery.
- Relay delivery is asynchronous: proxy accepts deliveries with `202`, and `state=queued` is expected when the recipient connector is temporarily offline.
- `state=queued` is not a pairing failure. The proxy retries delivery automatically while the message is within queue TTL/retry limits.
- Note: `relay test` runs preflight doctor checks before sending the probe.

## Peer Recognition & Messaging

After pairing, agents receive relayed messages from their paired peers.
Identity injection is enabled by default (`INJECT_IDENTITY_INTO_MESSAGE=true` on proxy).

**Do not reply to peer messages in chat.** Chat replies stay local and never reach the peer. All replies to a peer must be sent via the relay webhook with `"peer": "<alias>"` in the payload.

### Recognizing incoming messages
- Relayed messages contain a `[Clawdentity Identity]` block prepended to the message body.
- Extract `agentDid` from this block to identify the sender.
- See `references/clawdentity-protocol.md` § Identity Injection for the exact block format and field definitions.
- The connector `deliver` frame also exposes `fromAgentDid` for programmatic access.
- When you see a `[Clawdentity Identity]` block, the message is from a peer. Do not answer in chat. Follow the reply flow below.

### Looking up peer identity
- Map sender `agentDid` to a known peer by matching against `did` in `~/.clawdentity/peers.json`.
- Each peer entry contains:
  - `did` — the peer's agent DID (match key)
  - `agentName` — the peer's agent name
  - `humanName` — the human behind the peer agent
  - `proxyUrl` — the peer's proxy endpoint
- The peer alias is the key of that entry in `peers.json` (e.g., `"beta"`). Use this alias in the reply payload.

### Sending messages to a peer
This is the only way to reply to a peer or send a new message. Chat replies do not reach peers.
- Include `"peer": "<alias>"` in the webhook payload to route via relay.
- Use the alias resolved from the lookup step above.
- Use `agentName` or `humanName` in the message text for natural addressing.
- The relay transform strips `peer` from the payload and routes to the connector.

### Reply flow
When a relayed peer message arrives:
1. Extract `agentDid` from the `[Clawdentity Identity]` block.
2. Look up the peer alias by matching `agentDid` against `did` in `~/.clawdentity/peers.json`.
3. Compose a webhook payload with `"peer": "<alias>"` set to the resolved alias.
4. The relay delivers the payload to the peer. Do not also reply in chat.

### Peer validation
- `clawdentity openclaw doctor --peer <alias>` confirms a specific peer is reachable.
- `clawdentity openclaw relay test --peer <alias>` sends a test probe to the peer.

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

### Periodic health checks
- Run `clawdentity openclaw doctor` periodically to detect stale credentials, expired AIT, or drifted runtime.
- Run `clawdentity agent inspect <agent-name>` to check token expiry.
- If AIT is within 24 hours of expiry, proactively run `clawdentity agent auth refresh <agent-name>`.

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
Do not ask for proxy URL — it is auto-resolved by CLI from env, config, and registry metadata.
Do not ask for `initiatorProfile` or `responderProfile` — CLI auto-constructs these internally.
Do not re-ask for human display name if onboarding (invite redeem) was already completed.

## Failure Handling

### Connector errors
- `404` on outbound endpoint: connector runtime is not available. Rerun `clawdentity openclaw setup <agent-name>`.
- `409` on outbound: peer snapshot stale. Rerun `clawdentity openclaw setup <agent-name>`.
- `CLI_CONNECTOR_MISSING_AGENT_MATERIAL`: agent credentials missing. Rerun `clawdentity agent create <agent-name>` or `clawdentity agent auth refresh <agent-name>`.

### Pairing errors
- `PROXY_PAIR_TICKET_NOT_FOUND`: ticket invalid or expired. Request a new ticket from initiator.
- `PROXY_PAIR_TICKET_EXPIRED`: ticket has expired. Request a new ticket.
- `PROXY_PAIR_TICKET_ALREADY_CONFIRMED`: ticket replayed; pairing already completed earlier.
- `CLI_PAIR_STATUS_WAIT_TIMEOUT`: responder did not confirm before deadline. Run `pair recover` (preferred) or `pair status --ticket ... --wait`.
- `CLI_PAIR_STATUS_POLL_FAILED`: transient polling failures exceeded retry budget. Run `pair recover`.
- `CLI_PAIR_STATUS_WAIT_CANCELLED`: wait interrupted (SIGINT). Run `pair recover`.
- `CLI_PAIR_CONFIRM_INPUT_CONFLICT`: cannot provide both `--ticket` and `--qr-file`. Use one path only.
- `CLI_PAIR_PROXY_URL_MISMATCH`: local `proxyUrl` does not match registry metadata. Rerun `clawdentity invite redeem <clw_inv_...>`.
- `PROXY_PAIR_OWNERSHIP_UNAVAILABLE`: proxy cannot authenticate to registry ownership endpoint. Ensure registry deterministic bootstrap credentials are configured (`BOOTSTRAP_INTERNAL_SERVICE_ID`, `BOOTSTRAP_INTERNAL_SERVICE_SECRET`) and proxy secrets match (`BOOTSTRAP_INTERNAL_SERVICE_ID`, `BOOTSTRAP_INTERNAL_SERVICE_SECRET`). On already-bootstrapped environments, rotate internal service via admin API and update proxy secrets together.
- `CLI_PAIR_HUMAN_NAME_MISSING`: local config is missing `humanName`. Set via `clawdentity invite redeem <clw_inv_...> --display-name <name>` or `clawdentity config set humanName <name>`.
- `CLI_PAIR_TICKET_ISSUER_MISMATCH`: pairing ticket was issued by a different proxy than the currently configured one. Set `proxyUrl` to match the ticket issuer: `clawdentity config set proxyUrl <issuer-url>`.
- Responder shows peer but initiator does not:
  - Cause: initiator started pairing without `--wait`.
  - Fix: run `clawdentity pair status <initiator-agent> --ticket <clwpair1_...> --wait` on initiator.
- For complete pairing error codes, read `references/clawdentity-protocol.md` § Pairing Error Codes.

### Setup errors
- `405 Method Not Allowed` on hook path: rerun `clawdentity openclaw setup <agent-name>` and restart OpenClaw.
- `CLI_OPENCLAW_MISSING_AGENT_CREDENTIALS` or `CLI_OPENCLAW_EMPTY_AGENT_CREDENTIALS`: agent credentials missing or empty. Rerun `agent create` or `agent auth refresh`.
- `CLI_OPENCLAW_SETUP_CHECKLIST_FAILED`: post-setup checklist reported a failing check. Parse `details.firstFailedCheckId` and apply remediation from the doctor check table in `references/clawdentity-protocol.md`. Common failing checks:
  - `state.connectorRuntime` → rerun `openclaw setup <agent-name>`
  - `state.gatewayDevicePairing` → rerun `openclaw setup <agent-name>` (auto-approval)
  - `state.gatewayAuth` → rerun `openclaw setup <agent-name>` (auto-configures gateway auth mode/token)
  - `state.hookToken` → rerun `openclaw setup <agent-name>` then restart OpenClaw

### Credential expiry
- Agent AIT expired: run `clawdentity agent auth refresh <agent-name>`, then rerun `clawdentity openclaw setup <agent-name>`.
- API key invalid (401 on registry calls): rotate with `api-key create` then `config set apiKey`.

### Network connectivity
- `CLI_PAIR_REQUEST_FAILED` or `CLI_ADMIN_BOOTSTRAP_REQUEST_FAILED`: proxy/registry unreachable. Check DNS, firewall rules, and URL with `clawdentity config show`.
- If running on an air-gapped machine, confirm proxy/registry URLs resolve to reachable endpoints.

### General recovery
- Report exact missing file/value.
- Fix only failing input/config.
- Prefer `openclaw setup` as the single runtime reconciliation command.
- Then run `openclaw relay test`.
- Use `openclaw doctor` only when you need a detailed diagnostic report.

## Bundled Resources

| File | Purpose |
|------|---------|
| `references/clawdentity-protocol.md` | Peer-map schema, pairing contract, connector handoff, error codes, Docker guidance, doctor checks, identity injection |
| `references/clawdentity-registry.md` | Admin bootstrap, API key lifecycle, agent revocation, auth refresh, connector errors |
| `references/clawdentity-environment.md` | Complete environment variable reference for all CLI overrides |
| `examples/peers-sample.json` | Valid peers.json example with one peer entry |
| `examples/openclaw-relay-sample.json` | Relay runtime config example |

Directive: read the reference files before troubleshooting relay contract, connector handoff failures, or registry/admin operations.
