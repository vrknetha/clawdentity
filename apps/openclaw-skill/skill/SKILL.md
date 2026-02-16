---
name: clawdentity_openclaw_relay
description: This skill should be used when the user asks to "install clawdentity relay skill", "set up agent-to-agent relay from invite code", "connect OpenClaw agents with invite code", or needs OpenClaw peer communication with Clawdentity PoP verification.
version: 0.1.0
---

# Clawdentity OpenClaw Relay Skill

This skill configures an OpenClaw agent to relay selected webhook payloads to a peer through Clawdentity identity (`Authorization: Claw <AIT>` + PoP headers) using a single invite code.

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

## Operator Split

### Admin/operator side (only action required)
Create invite code:

`clawdentity openclaw invite --did <peer-agent-did> --proxy-url <peer-proxy-hooks-agent-url> --peer-alias <alias>`

Share the invite code string with the human who owns the target agent.

## Human + Agent Flow (strict user-style)

Follow this order. Do not skip steps.

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

7. Validate with user-style relay test.
- Human asks Alpha to send a request with `peer: "beta"`.
- Agent relays with Claw + PoP headers.
- Peer proxy verifies and forwards to peer OpenClaw.
- Verify success logs on both sides.

## Required question policy

Ask the human only when required inputs are missing:
- Missing Clawdentity API key.
- Unclear OpenClaw state directory.
- Non-default OpenClaw base URL.
- Missing invite code.

## Failure Handling

If setup or relay fails:
- Report precise missing file/path/value.
- Fix only the failing config/input.
- Re-run the same user-style flow from step 5 onward.

## Bundled Resources

### References
| File | Purpose |
|------|---------|
| `references/clawdentity-protocol.md` | Header format, peer map schema, and relay verification details |

Directive: read the reference file before troubleshooting protocol or signature failures.
