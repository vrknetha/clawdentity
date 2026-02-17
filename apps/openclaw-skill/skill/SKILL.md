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

Provide a valid invite code string before running this skill.
Invite creation is outside this skill scope; this skill focuses on setup, pairing, and relay validation.

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
- Configure registry URL and API key when missing:
  - `clawdentity config set registryUrl <registry-url>`
  - `clawdentity config set apiKey <api-key>`
- Create and inspect local OpenClaw agent identity:
  - `clawdentity agent create <agent-name> --framework openclaw`
  - `clawdentity agent inspect <agent-name>`
- Apply OpenClaw invite setup:
  - `clawdentity openclaw setup <agent-name> --invite-code <invite-code>`
- Start connector runtime for relay handoff:
  - `clawdentity connector start <agent-name>`
- Optional persistent connector autostart:
  - `clawdentity connector service install <agent-name>`
- Validate health and delivery:
  - `clawdentity openclaw doctor`
  - `clawdentity openclaw relay test --peer <alias>`

Pairing bootstrap for trust policy is API-based in the current release (no dedicated pairing CLI command yet):

- Owner/initiator starts pairing on initiator proxy:
  - `POST /pair/start`
  - Requires `Authorization: Claw <AIT>` and `x-claw-owner-pat`
  - Body: `{"agentDid":"<responder-agent-did>"}`
- Responder confirms on responder proxy:
  - `POST /pair/confirm`
  - Requires `Authorization: Claw <AIT>`
  - Body: `{"pairingCode":"<code-from-start>"}`

Successful confirm establishes mutual trust for the two agent DIDs. After confirm, both directions are allowed for trusted delivery.

1. Confirm prerequisites with the human.
- Confirm `clawdentity` CLI is installed and runnable.
- Confirm API key exists for this agent (if missing, ask the human for it).
- Confirm OpenClaw state directory path if non-default.
- Confirm OpenClaw base URL if local endpoint is non-default.

2. Confirm skill artifact exists in workspace skills directory.
- Ensure `~/.openclaw/workspace/skills/clawdentity-openclaw-relay/relay-to-peer.mjs` exists.
- If missing, install/update skill package contents before setup.

3. Configure local Clawdentity identity for this OpenClaw agent.
- Run `clawdentity config init`.
- If needed, ask the human for API key and run `clawdentity config set apiKey <key>`.
- Create identity: `clawdentity agent create <agent-name> --framework openclaw`.
- Verify identity: `clawdentity agent inspect <agent-name>`.

4. Ask the human for invite code.
- Prompt exactly for one invite code string.
- Do not ask for DID/proxy URL when invite code is present.

5. Run automated setup from invite code.
- Execute:
  `clawdentity openclaw setup <agent-name> --invite-code <invite-code>`
- Use `--openclaw-dir <path>` when state directory is non-default.
- Use `--openclaw-base-url <url>` when local OpenClaw HTTP endpoint is non-default.
- Use `--peer-alias <alias>` only when alias override is required.

6. Verify setup outputs.
- Confirm setup reports:
  - peer alias
  - peer DID
  - updated OpenClaw config path
  - installed transform path
  - OpenClaw base URL
  - relay runtime config path
- Confirm `~/.clawdentity/openclaw-agent-name` is set to the local agent name.

7. Start connector runtime for local relay handoff.
- Run `clawdentity connector start <agent-name>`.
- Optional: run `clawdentity connector service install <agent-name>` for persistent autostart.

8. Complete trust pairing bootstrap.
- Run pairing start (`POST /pair/start`) from the owner/initiator side.
- Share returned one-time `pairingCode` with responder side.
- Run pairing confirm (`POST /pair/confirm`) from responder side.
- Confirm pairing success before relay test.

9. Validate with user-style relay test.
- Run `clawdentity openclaw doctor` to verify setup health and remediation hints.
- Run `clawdentity openclaw relay test --peer <alias>` to execute a probe.
- Confirm probe success and connector-mediated delivery logs.
- Human asks Alpha to send a real request with `peer: "beta"` and verifies peer delivery.

## Required question policy

Ask the human only when required inputs are missing:
- Missing Clawdentity API key.
- Unclear OpenClaw state directory.
- Non-default OpenClaw base URL.
- Missing invite code.
- Local connector runtime or peer network route is unknown or unreachable from agent runtime.

## Failure Handling

If setup or relay fails:
- Report precise missing file/path/value.
- Fix only the failing config/input.
- Ensure connector runtime is active (`clawdentity connector start <agent-name>`).
- Re-run `clawdentity openclaw doctor`.
- Re-run `clawdentity openclaw relay test --peer <alias>`.
- Re-run the same user-style flow from step 5 onward only after health checks pass.

## Bundled Resources

### References
| File | Purpose |
|------|---------|
| `references/clawdentity-protocol.md` | Invite format, peer map schema, connector handoff envelope, and runtime failure mapping |

Directive: read the reference file before troubleshooting relay contract or connector handoff failures.
