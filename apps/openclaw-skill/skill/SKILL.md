---
name: clawdentity_openclaw_relay
description: This skill should be used when the user asks to "install clawdentity relay skill", "set up agent-to-agent relay from invite code", "connect OpenClaw agents with invite code", or needs OpenClaw peer communication through the local Clawdentity connector runtime.
version: 0.1.0
---

# Clawdentity OpenClaw Relay Skill

This skill configures an OpenClaw agent to relay selected webhook payloads to a peer through the local Clawdentity connector runtime using a single invite code.

## Trigger Conditions

Use this skill when any of the following are requested:
- Install relay support for OpenClaw peer communication.
- Complete first-time setup from an invite code.
- Repair broken relay setup after config drift.
- Verify invite-code onboarding and peer mapping.

## Filesystem Truth (must be used exactly)

### OpenClaw state files
- OpenClaw state root (default): `~/.openclaw`
- OpenClaw config: `~/.openclaw/openclaw.json`
- Transform target path: `~/.openclaw/hooks/transforms/relay-to-peer.mjs`
- Workspace skill location: `~/.openclaw/workspace/skills/clawdentity-openclaw-relay/SKILL.md`
- Default transform source expected by CLI setup:
  `~/.openclaw/workspace/skills/clawdentity-openclaw-relay/relay-to-peer.mjs`

### Clawdentity identity files
- Clawdentity root: `~/.clawdentity`
- Agent config: `~/.clawdentity/config.json`
- Agent identity directory: `~/.clawdentity/agents/<agent-name>/`
- Agent private key: `~/.clawdentity/agents/<agent-name>/secret.key`
- Agent AIT token: `~/.clawdentity/agents/<agent-name>/ait.jwt`
- Peer map: `~/.clawdentity/peers.json`
- Local selected agent marker: `~/.clawdentity/openclaw-agent-name`
- Relay runtime config: `~/.clawdentity/openclaw-relay.json`

## Invite Input Assumption

Invite creation is outside this skill scope. This skill consumes two invite types:
- Registry onboarding invite code (`clw_inv_...`) to obtain PAT when local API key is missing.
- OpenClaw peer relay invite code (`clawd1_...`) for `openclaw setup`.

## Human + Agent Flow (strict user-style)

Follow this order. Do not skip steps.

## Tool Execution Contract (Agent)

This skill is operational. The agent must execute side effects via tools.
- Use the `exec` tool for npm/CLI/filesystem actions needed by onboarding.
- Do not ask the human to run shell commands that the agent can run itself.
- Ask the human only for missing secrets/inputs (for example API key or invite code).
- Report final status with concrete outputs (local DID, peer alias, written paths).

## CLI Command Utilization (required)

Use these commands as the default execution path for skill utilization:

- Initialize local CLI config:
  - `clawdentity config init`
  - `clawdentity config init --registry-url <registry-url>` (supports first-run registry URL override)
  - or set env before init: `CLAWDENTITY_REGISTRY_URL=<registry-url>` (primary global override)
  - compatible alias: `CLAWDENTITY_REGISTRY=<registry-url>`
- Configure registry URL and API key when missing:
  - `clawdentity config set registryUrl <registry-url>`
- Complete registry onboarding when API key is missing:
  - `clawdentity invite redeem <registry-invite-code>`
  - `clawdentity invite redeem <registry-invite-code> --registry-url <registry-url>`
- Configure API key only for non-invite fallback:
  - `clawdentity config set apiKey <api-key>`
- Create and inspect local OpenClaw agent identity:
  - `clawdentity agent create <agent-name> --framework openclaw`
  - `clawdentity agent inspect <agent-name>`
- Apply OpenClaw invite setup:
  - `clawdentity openclaw setup <agent-name> --invite-code <peer-relay-invite-code>`
- Start connector runtime for relay handoff:
  - `clawdentity connector start <agent-name>`
- Optional persistent connector autostart:
  - `clawdentity connector service install <agent-name>`
- Validate health and delivery:
  - `clawdentity openclaw doctor`
  - `clawdentity openclaw relay test --peer <alias>`

Pairing bootstrap uses CLI commands in the current release:

- Owner/initiator starts pairing on initiator proxy:
  - `clawdentity pair start <initiator-agent-name> --proxy-url <initiator-proxy-url> --qr`
  - Optionally pass explicit owner PAT: `--owner-pat <token>`
- Responder confirms on responder proxy:
  - `clawdentity pair confirm <responder-agent-name> --qr-file <ticket-qr-file> --proxy-url <responder-proxy-url>`
  - optional global proxy URL env fallback: `CLAWDENTITY_PROXY_URL=<proxy-url>`

Successful confirm establishes mutual trust for the two agent DIDs. After confirm, both directions are allowed for trusted delivery.

1. Confirm prerequisites with the human.
- Confirm `clawdentity` CLI is installed and runnable.
- Confirm local agent name.
- Confirm API key exists locally or registry onboarding invite code (`clw_inv_...`) is available.
- Confirm OpenClaw peer relay invite code (`clawd1_...`) is available for setup.
- Do not request API key and registry invite code in the same prompt.
- Do not request registry invite code and peer relay invite code in the same prompt.
- Only ask for API key when neither local API key nor registry onboarding invite code is available.
- Confirm OpenClaw state directory path if non-default.
- Confirm OpenClaw base URL if local endpoint is non-default.
- Confirm each side proxy URL for pairing command execution.

2. Confirm skill artifact exists in workspace skills directory.
- Ensure `~/.openclaw/workspace/skills/clawdentity-openclaw-relay/relay-to-peer.mjs` exists.
- If missing, install/update skill package contents before setup.

3. Initialize local Clawdentity config.
- Run `clawdentity config init`.
- Use `clawdentity config init --registry-url <registry-url>` when registry URL override is required.

4. Complete registry onboarding auth before agent creation.
- If API key already exists, continue.
- Else redeem registry onboarding invite:
  - `clawdentity invite redeem <registry-invite-code>`
  - optional: `--registry-url <registry-url>`
- If registry invite code is unavailable, fallback to API key path:
  - ask human for API key
  - run `clawdentity config set apiKey <api-key>`

5. Configure local Clawdentity identity for this OpenClaw agent.
- Create identity: `clawdentity agent create <agent-name> --framework openclaw`.
- Verify identity: `clawdentity agent inspect <agent-name>`.

6. Run automated setup from peer relay invite code.
- Execute:
  `clawdentity openclaw setup <agent-name> --invite-code <peer-relay-invite-code>`
- Use `--openclaw-dir <path>` when state directory is non-default.
- Use `--openclaw-base-url <url>` when local OpenClaw HTTP endpoint is non-default.
- Use `--peer-alias <alias>` only when alias override is required.

7. Verify setup outputs.
- Confirm setup reports:
  - peer alias
  - peer DID
  - updated OpenClaw config path
  - installed transform path
  - OpenClaw base URL
  - relay runtime config path
- Confirm `~/.clawdentity/openclaw-agent-name` is set to the local agent name.

8. Start connector runtime for local relay handoff.
- Run `clawdentity connector start <agent-name>`.
- Optional: run `clawdentity connector service install <agent-name>` for persistent autostart.

9. Complete trust pairing bootstrap.
- Run pairing start from owner/initiator side:
  - `clawdentity pair start <initiator-agent-name> --proxy-url <initiator-proxy-url> --qr`
- Share the one-time QR image with responder side.
- Run pairing confirm from responder side:
  - `clawdentity pair confirm <responder-agent-name> --qr-file <ticket-qr-file> --proxy-url <responder-proxy-url>`
- Confirm pairing success before relay test.

10. Validate with user-style relay test.
- Run `clawdentity openclaw doctor` to verify setup health and remediation hints.
- Run `clawdentity openclaw relay test --peer <alias>` to execute a probe.
- Confirm probe success and connector-mediated delivery logs.
- Human asks Alpha to send a real request with `peer: "beta"` and verifies peer delivery.

## Required question policy

Ask the human only when required inputs are missing:
- Missing local agent name.
- Missing peer relay invite code (`clawd1_...`).
- Missing registry onboarding invite code (`clw_inv_...`) when API key is absent.
- Missing Clawdentity API key only when registry onboarding invite code is unavailable.
- Missing initiator/responder proxy URLs for pairing commands.
- Unclear OpenClaw state directory.
- Non-default OpenClaw base URL.
- Local connector runtime or peer network route is unknown or unreachable from agent runtime.

## Failure Handling

If setup or relay fails:
- Report precise missing file/path/value.
- Fix only the failing config/input.
- Ensure connector runtime is active (`clawdentity connector start <agent-name>`).
- Re-run `clawdentity openclaw doctor`.
- Re-run `clawdentity openclaw relay test --peer <alias>`.
- Re-run the same user-style flow from step 6 onward only after health checks pass.

## Bundled Resources

### References
| File | Purpose |
|------|---------|
| `references/clawdentity-protocol.md` | Invite format, peer map schema, connector handoff envelope, and runtime failure mapping |

Directive: read the reference file before troubleshooting relay contract or connector handoff failures.
