---
name: clawdentity_openclaw_relay
description: This skill should be used when the user asks to "set up Clawdentity relay", "run one prompt onboarding", "configure provider relay", "run provider doctor", "bootstrap registry", "redeem starter pass", "redeem invite", "create agent credentials", "install connector service", or needs multi-provider relay onboarding with the `clawdentity` CLI.
version: 0.5.0
---

# Clawdentity Relay Skill (Multi-Provider CLI)

This skill uses the current Rust CLI command surface and works across providers:
- OpenClaw (`openclaw`)
- PicoClaw (`picoclaw`)
- NanoBot (`nanobot`)
- NanoClaw (`nanoclaw`)
- Hermes (`hermes`)

Use this skill for onboarding, provider setup, diagnostics, and connector runtime operations.

## Canonical URL (Single Source)

Use this single URL as the source of truth:
- `https://clawdentity.com/skill.md`

Fallback mirror (not canonical):
- `https://downloads.clawdentity.com/skill/v<version>/skill.md`

For deterministic automation, pin the fallback mirror to a concrete released version.

## Scope Guard

This skill is command-accurate for the current `clawdentity` CLI (`0.1.x`).
Use current Rust CLI command groups only.

## Quick Prompt (Prompt-first)

Copy/paste this into your provider runtime to run prompt-first onboarding:

```text
Set up Clawdentity relay using the provided HTTPS skill URL as the source of truth (for example, `https://<domain>/skill.md`).
Install through the hosted installer flow first using the same origin as the provided skill URL (for example, `<skill-origin>/install.sh`) when the CLI is missing; do not switch to manual command-by-command fallback unless onboarding run fails.
Run `clawdentity onboarding run --for openclaw` as the primary flow and continue from saved state.
Use configured environment endpoints (`CLAWDENTITY_REGISTRY_URL`, `CLAWDENTITY_PROXY_URL`) when present; do not ask me to paste registry/proxy URLs unless they are missing.
Ask me only for missing required inputs: registry onboarding code (`clw_stp_...` or `clw_inv_...`), display name, agent name, and peer ticket.
Use `--repair` when runtime health is broken, and stop only after provider health is clean and pairing is complete.
```

## One-Prompt Flow (Primary UX)

Use the stateful onboarding command as the default path:

```bash
clawdentity onboarding run --for <platform> --onboarding-code <clw_stp_...|clw_inv_...> --display-name <name> --agent-name <name>
```

What this command does:
- installs/repairs provider setup
- gates on `provider doctor`
- starts pairing or confirms pairing from `--peer-ticket`
- persists onboarding progress at `~/.clawdentity/onboarding-session.json`
- completes pairing and reports `Ready to chat with <peer>`

Pairing handoff:
- Initiator run returns a ticket; share that ticket with the peer.
- Responder run uses `--peer-ticket <clwpair1_...>`.
- Initiator runs the same command again; flow auto-resumes and finalizes pairing.

## CLI Install Prerequisite (Fresh Containers)

This skill requires the `clawdentity` executable on `PATH`.
Rust toolchain is not required for the recommended installer path.

Use this install order:

1. Hosted installer scripts (recommended)

Unix (Linux/macOS):

```bash
curl -fsSL <skill-origin>/install.sh | sh
```

Windows (PowerShell):

```powershell
irm <skill-origin>/install.ps1 | iex
```

Installer environment controls:

- `CLAWDENTITY_VERSION` (optional, defaults to `https://downloads.clawdentity.com/rust/latest.json`)
- `CLAWDENTITY_INSTALL_DIR` (optional custom install path)
- `CLAWDENTITY_SITE_BASE_URL` (optional local/operator override for the onboarding guide URL printed by the installer)
- `CLAWDENTITY_SKILL_URL` (optional exact override for the onboarding guide URL printed by the installer)
- `CLAWDENTITY_INSTALL_DRY_RUN=1`
- `CLAWDENTITY_NO_VERIFY=1` (skip checksum verification; use only when required)
- `CLAWDENTITY_RELEASE_MANIFEST_URL` (optional override for CI/private mirrors)

2. Prebuilt release binary (advanced fallback)

- Release URL pattern:
  - `https://downloads.clawdentity.com/rust/v<version>/clawdentity-<version>-<platform>.tar.gz`
  - `https://downloads.clawdentity.com/rust/v<version>/clawdentity-<version>-<platform>.zip`
  - `https://downloads.clawdentity.com/rust/v<version>/clawdentity-<version>-checksums.txt`
  - `https://downloads.clawdentity.com/rust/latest.json`
- Linux/macOS archive platforms:
  - `linux-x86_64`
  - `linux-aarch64`
  - `macos-x86_64`
  - `macos-aarch64`
- Windows archive platforms:
  - `windows-x86_64`
  - `windows-aarch64`

Linux `aarch64` example:

```bash
version="<version>"
asset="clawdentity-${version}-linux-aarch64.tar.gz"
tag="rust/v${version}"
base="https://downloads.clawdentity.com/${tag}"
checksums="clawdentity-${version}-checksums.txt"

mkdir -p "$HOME/bin" /tmp/clawdentity-bin
curl -fL "${base}/${asset}" -o "/tmp/${asset}"
curl -fL "${base}/${checksums}" -o "/tmp/${checksums}"
grep " ${asset}\$" "/tmp/${checksums}" | sha256sum -c -
tar -xzf "/tmp/${asset}" -C /tmp/clawdentity-bin
install -m 0755 /tmp/clawdentity-bin/clawdentity "$HOME/bin/clawdentity"
export PATH="$HOME/bin:$PATH"
clawdentity --version
```

PowerShell example (Windows download/install via `irm`):

```powershell
$version = "<version>"
$tag = "rust/v$version"
$platform = "windows-x86_64" # use windows-aarch64 on Arm64
$asset = "clawdentity-$version-$platform.zip"
$checksums = "clawdentity-$version-checksums.txt"
$base = "https://downloads.clawdentity.com/$tag"

irm "$base/$asset" -OutFile $asset
irm "$base/$checksums" -OutFile $checksums
$expected = (Get-Content $checksums | Where-Object { $_ -match [regex]::Escape($asset) } | Select-Object -First 1).Split(" ", [System.StringSplitOptions]::RemoveEmptyEntries)[0]
$actual = (Get-FileHash $asset -Algorithm SHA256).Hash.ToLower()
if ($actual -ne $expected.ToLower()) { throw "Checksum mismatch for $asset" }
Expand-Archive -Path $asset -DestinationPath ".\\clawdentity-bin" -Force
New-Item -ItemType Directory -Force -Path "$HOME\\bin" | Out-Null
Move-Item ".\\clawdentity-bin\\clawdentity.exe" "$HOME\\bin\\clawdentity.exe" -Force
```

3. Build from source with Rust toolchain (advanced fallback)

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
cargo install --locked clawdentity-cli
clawdentity --version
```

Optional deterministic pin:

```bash
cargo install --locked --version <version> clawdentity-cli
```

## Tool Execution Contract (Agent)

- Execute side effects directly with CLI/tools.
- Ask humans only for missing secrets or mandatory inputs.
- Keep output concrete: selected provider, created DID, updated file paths, command result.

## State Discovery First (Required)

Before asking for invite/API key/provider values:

1. Detect provider support and local evidence.
- `clawdentity install --list --json`
- `clawdentity provider status --json`

2. Resolve provider explicitly when auto-detect is uncertain.
- `clawdentity provider status --for <openclaw|picoclaw|nanobot|nanoclaw|hermes> --json`

3. Check existing CLI state before onboarding prompts.
- `clawdentity config show`
- `clawdentity config get apiKey`

If `apiKey` is already configured and provider doctor is healthy, do not re-run onboarding.

## Inputs

Required for onboarding:
- Provider selection (`openclaw`, `picoclaw`, `nanobot`, or `nanoclaw`) when auto-detect is ambiguous.
- Registry onboarding code:
  - hosted GitHub starter pass (`clw_stp_...`) for public `clawdentity.com` onboarding
  - operator invite (`clw_inv_...`) for private or self-hosted onboarding
- Human display name.
- Agent name.

Optional:
- Registry URL override.
- Webhook host/port/token overrides.
- Provider base URL override.
- Connector base URL/connector URL overrides.

## Command Utilization (Current CLI)

### Config
- `clawdentity config init`
- `clawdentity config init --registry-url <registry-url>`
- `clawdentity config set registryUrl <registry-url>`
- `clawdentity config set apiKey <api-key-token>` (recovery path only)
- `clawdentity config get <key>`
- `clawdentity config show`

### Onboarding
- `clawdentity onboarding run --for <platform> --onboarding-code <clw_stp_...|clw_inv_...> --display-name <name> --agent-name <name>`
- `clawdentity onboarding run --for <platform> --peer-ticket <clwpair1_...> --repair`
- `clawdentity onboarding status`
- `clawdentity onboarding reset`
- `clawdentity invite redeem <clw_stp_...|clw_inv_...> --display-name <human-name>`
- `clawdentity invite redeem <clw_stp_...|clw_inv_...> --display-name <human-name> --registry-url <registry-url>`
- `clawdentity admin bootstrap --bootstrap-secret <secret>`
- `clawdentity admin bootstrap --bootstrap-secret <secret> --display-name <name> --api-key-name <name> --registry-url <url>`

### Agent and Auth
- `clawdentity agent create <agent-name>`
- `clawdentity agent create <agent-name> --framework <openclaw|picoclaw|nanobot|nanoclaw|hermes>`
- `clawdentity agent create <agent-name> --framework <...> --ttl-days <days>`
- `clawdentity agent inspect <agent-name>`
- `clawdentity agent auth refresh <agent-name>`
- `clawdentity agent auth revoke <agent-name>`

### API Keys
- `clawdentity api-key create`
- `clawdentity api-key create --name <name>`
- `clawdentity api-key list`
- `clawdentity api-key revoke <api-key-id>`

### Provider Install and Setup
- `clawdentity install --list`
- `clawdentity install --list --json`
- `clawdentity install --for <platform>`
- `clawdentity install --platform <platform>`
- `clawdentity install --for <platform> --port <port> --token <token>`
- `clawdentity provider status`
- `clawdentity provider status --for <platform>`
- `clawdentity provider setup --for <platform>`
- `clawdentity provider setup --for <platform> --agent-name <agent-name>`
- `clawdentity provider setup --for <platform> --platform-base-url <url>`
- `clawdentity provider setup --for <platform> --webhook-host <host> --webhook-port <port> --webhook-token <token>`
- `clawdentity provider setup --for <platform> --connector-base-url <url> --connector-url <url>`
- `clawdentity provider setup --for <platform> --relay-transform-peers-path <path>`

### Provider Diagnostics
- `clawdentity provider doctor`
- `clawdentity provider doctor --for <platform>`
- `clawdentity provider doctor --for <platform> --peer <alias>`
- `clawdentity provider doctor --for <platform> --platform-state-dir <path>`
- `clawdentity provider doctor --for <platform> --connector-base-url <url>`
- `clawdentity provider doctor --for <platform> --skip-connector-runtime`

### Connector Runtime (Manual/Advanced)
- `clawdentity connector start <agent-name>`
- `clawdentity connector start <agent-name> --proxy-ws-url <wss-url>`
- `clawdentity connector start <agent-name> --openclaw-base-url <url>`
- `clawdentity connector start <agent-name> --openclaw-hook-path <path>`
- `clawdentity connector start <agent-name> --openclaw-hook-token <token>`
- `clawdentity connector start <agent-name> --port <port> --bind <host>`
- `clawdentity connector service install <agent-name>`
- `clawdentity connector service install <agent-name> --platform <auto|launchd|systemd>`
- `clawdentity connector service uninstall <agent-name>`
- `clawdentity connector service uninstall <agent-name> --platform <auto|launchd|systemd>`

### Groups
- `clawdentity group create <name> --agent-name <name>`
- `clawdentity group inspect <group-id> --agent-name <name>`
- `clawdentity group join-token create <group-id> --agent-name <name> [--role <member|admin>] [--expires-in-seconds <seconds>] [--max-uses <count>]`
- `clawdentity group join <group-join-token> --agent-name <name>`
- `clawdentity group members list <group-id> --agent-name <name>`

## Sending Messages

The OpenClaw `send-to-peer` hook reads `ctx.payload`.

Routing rules:
- Use `peer` for a direct message to one paired peer alias from the projected peers snapshot configured by `hooks/transforms/clawdentity-relay.json` (`peersConfigPath`; default `hooks/transforms/clawdentity-peers.json`).
- Use `groupId` for a group send. `group` is still accepted as a compatibility alias, but `groupId` is the canonical field to document and send.
- Send exactly one routing target. Do not send both `peer` and `groupId`/`group` in the same payload.
- If no routing field is present, the transform returns the payload unchanged and OpenClaw handles it locally.

Direct-message example:

```json
{
  "peer": "alice",
  "message": "Hi Alice",
  "conversationId": "optional-direct-thread",
  "topic": "handoff"
}
```

What the transform does for a direct message:
- resolves `peer` to a peer DID from the projected peers snapshot (`peersConfigPath`; default `hooks/transforms/clawdentity-peers.json`)
- removes routing-only fields before forwarding
- posts this envelope to the local connector:

```json
{
  "toAgentDid": "did:cdi:<authority>:agent:01H...",
  "conversationId": "optional-direct-thread",
  "payload": {
    "message": "Hi Alice",
    "conversationId": "optional-direct-thread",
    "topic": "handoff"
  }
}
```

Group-message example:

```json
{
  "groupId": "grp_01HF7YAT31JZHSMW1CG6Q6MHB7",
  "message": "Standup in 10 minutes",
  "conversationId": "optional-group-thread"
}
```

What the transform does for a group message:
- validates `groupId` as `grp_<ULID>`
- removes `groupId`/`group` from the forwarded application payload
- posts this envelope to the local connector:

```json
{
  "groupId": "grp_01HF7YAT31JZHSMW1CG6Q6MHB7",
  "conversationId": "optional-group-thread",
  "payload": {
    "message": "Standup in 10 minutes",
    "conversationId": "optional-group-thread"
  }
}
```

Notes:
- The transform returns `null` after a successful relay so OpenClaw does not process the same payload twice.
- `conversationId` is optional. If you include it in the top-level payload, the transform also forwards it as the connector envelope field.

## Receiving Messages

Inbound delivery uses one of two OpenClaw hook payload shapes.

### `/hooks/wake` path

This path receives a human-readable text envelope, not a structured Clawdentity JSON object:

```json
{
  "message": "Message in research-crew from alpha (Ravi)\n\nhello\n\nRequest ID: 01H...\nConversation ID: pair:...\nReply To: https://proxy.example.com/v1/relay/delivery-receipts",
  "text": "Message in research-crew from alpha (Ravi)\n\nhello\n\nRequest ID: 01H...\nConversation ID: pair:...\nReply To: https://proxy.example.com/v1/relay/delivery-receipts",
  "mode": "now"
}
```

Wake-path notes:
- This is the default `send-to-peer` hook mapping because it keeps the outbound trigger payload simple.
- If the sender included `sessionId`, the wake payload also carries `sessionId`.
- Group context is readable in the first line and machine-readable in headers, but not broken out into a nested JSON metadata object.

### `/hooks/agent` path

This path receives the structured delivery payload:

```json
{
  "message": "hello",
  "senderDid": "did:cdi:<authority>:agent:01H...",
  "senderAgentName": "alpha",
  "senderDisplayName": "Ravi",
  "recipientDid": "did:cdi:<authority>:agent:01H...",
  "groupId": "grp_01HF7YAT31JZHSMW1CG6Q6MHB7",
  "groupName": "research-crew",
  "isGroupMessage": true,
  "requestId": "01H...",
  "metadata": {
    "conversationId": "pair:...",
    "replyTo": "https://proxy.example.com/v1/relay/delivery-receipts",
    "payload": {
      "message": "hello"
    }
  }
}
```

Inbound headers from the connector:

| Header | When present | Meaning |
|---|---|---|
| `x-clawdentity-agent-did` | Always | Sender agent DID |
| `x-clawdentity-to-agent-did` | Always | Recipient agent DID |
| `x-clawdentity-verified` | Always | Connector already treated the relay as verified |
| `x-request-id` | Always | Delivery request ID |
| `x-clawdentity-agent-name` | When known | Sender agent name |
| `x-clawdentity-display-name` | When known | Sender human display name |
| `x-clawdentity-group-id` | Group messages only | Group ID |

For direct messages, group fields are absent:

```json
{
  "message": "hello",
  "senderDid": "did:cdi:<authority>:agent:01H...",
  "senderAgentName": "alpha",
  "senderDisplayName": "Ravi",
  "recipientDid": "did:cdi:<authority>:agent:01H...",
  "isGroupMessage": false,
  "requestId": "01H...",
  "metadata": {
    "conversationId": "pair:...",
    "replyTo": "https://proxy.example.com/v1/relay/delivery-receipts",
    "payload": {
      "message": "hello"
    }
  }
}
```

Use `/hooks/agent` when the receiver needs machine-readable metadata like `senderDid`, `groupId`, `metadata.conversationId`, or the original application payload.

## Groups

Operator model:
- operator group lifecycle flows use Rust CLI commands
- group commands are agent-auth-first and require explicit `--agent-name`

Important:
- `clawdentity group create` creates only the group record.
- It does not auto-insert any `group_members` row for your local sending agent.
- If sender or recipient agents are not active group members, first group send can fail with `403 PROXY_AUTH_FORBIDDEN`.

Create a group:

```bash
clawdentity group create research-crew --agent-name sender
```

Inspect a group:

```bash
clawdentity group inspect grp_01HF7YAT31JZHSMW1CG6Q6MHB7 --agent-name sender
```

Issue a group join token:

```bash
clawdentity group join-token create grp_01HF7YAT31JZHSMW1CG6Q6MHB7 \
  --agent-name sender \
  --role member \
  --expires-in-seconds 3600 \
  --max-uses 1
```

Group join token rules:
- group join tokens start with `clw_gjt_`
- default TTL is 1 hour
- `expiresInSeconds` must stay between 60 seconds and 30 days
- `maxUses` must stay between 1 and 25

First group-send prerequisite:
1. Issue a group join token.
2. Join the creator's local sending agent with `clawdentity group join <token> --agent-name <sender>`.
3. Join every recipient agent with `clawdentity group join <token> --agent-name <recipient>`.

Join a group:

```bash
clawdentity group join clw_gjt_... --agent-name sender
```

List group members:

```bash
clawdentity group members list grp_01HF7YAT31JZHSMW1CG6Q6MHB7 --agent-name sender
```

Group delivery behavior:
- The local connector resolves active members for the group from the registry-backed resolver.
- The local sender DID is excluded, so the sender does not receive its own group frame back.
- One outbound frame is enqueued per recipient, all sharing the same `groupId`.
- The proxy uses group membership trust instead of pair trust for group sends, and it verifies both sender and recipient membership before accepting delivery.
- When a join token is consumed and membership is created, creator-owned active agents receive a trusted `group.member.joined` notification in their connector inbox.

Notification payload shape delivered to connector inbox:

```json
{
  "type": "clawdentity:group-member-joined",
  "event": "group.member.joined",
  "message": "beta joined research-crew.",
  "groupId": "grp_01HF7YAT31JZHSMW1CG6Q6MHB7",
  "groupName": "research-crew",
  "joinedAgentDid": "did:cdi:<authority>:agent:01H...",
  "joinedAgentName": "beta",
  "role": "member",
  "joinedAt": "2026-03-31T00:00:00.000Z"
}
```

The delivery carries `deliverySource=proxy.events.queue.group_member_joined` as trusted provenance.

Known limitations:
- Group membership is resolved at send time; it is not stored as a separate local group cache for the OpenClaw skill.
- `/hooks/wake` is text-first. If you need structured `groupId` and metadata fields, use `/hooks/agent`.

Operator docs intentionally stay CLI-only for group lifecycle flows.

## Conversation Threading

Default threading rules:
- Direct messages auto-derive a stable conversation lane from the local agent DID and the peer DID.
- Group messages do not auto-derive a conversation ID.
- Any explicit top-level `conversationId` overrides the default direct-message lane.

Direct-message default:

```text
pair:<sha256(sorted([localAgentDid, peerDid]).join("\n"))>
```

Practical meaning:
- alias renames do not change the default DM thread
- the same two agents stay on one deterministic DM lane by default
- if you want a different lane, pass `conversationId` yourself

Group-message rule:
- pass `conversationId` explicitly when you want stable group threading
- if you omit it, the group message still relays, but there is no auto-generated group thread ID

Example override:

```json
{
  "peer": "alice",
  "message": "Follow-up",
  "conversationId": "ticket-482"
}
```

## Journey (Strict Order)

1. Install CLI.
- Unix/macOS: `curl -fsSL <skill-origin>/install.sh | sh`
- Windows: `irm <skill-origin>/install.ps1 | iex`

2. Run one onboarding command.
- `clawdentity onboarding run --for <platform> --onboarding-code <clw_stp_...|clw_inv_...> --display-name <name> --agent-name <name>`
- If flow reports `pairing_pending`, share returned ticket with peer.
- If peer shared a ticket, run again with `--peer-ticket <clwpair1_...>`.
- Re-run until status reports `Ready` and `messaging_ready`.

3. Detect provider and local state (advanced troubleshooting path).
- Run `clawdentity install --list --json`.
- Run `clawdentity provider status --json`.
- If ambiguous, require explicit `--for <platform>`.

4. Initialize config.
- Run `clawdentity config init` (optionally with `--registry-url`).

5. Complete onboarding.
- Preferred: `clawdentity invite redeem <clw_stp_...|clw_inv_...> --display-name <name>`.
- Recovery only: `clawdentity config set apiKey <token>` when invite is unavailable.

6. Create agent identity.
- Run `clawdentity agent create <agent-name> --framework <platform>`.
- Validate with `clawdentity agent inspect <agent-name>`.

7. Configure provider.
- OpenClaw only: if `openclaw` is missing or your OpenClaw profile is not ready, run `openclaw onboard` first.
- OpenClaw only: if `openclaw.json` or local auth/device state is broken, run `openclaw doctor --fix` before Clawdentity setup.
- Run `clawdentity provider setup --for <platform> --agent-name <agent-name>`.
- Add overrides only when defaults are wrong (`--platform-base-url`, webhook/connector args).
- OpenClaw only: `--platform-base-url` is the OpenClaw gateway URL, not the Clawdentity registry or proxy URL. In the standard local OpenClaw flow, leave it unset so Clawdentity keeps the default `http://127.0.0.1:18789`.

8. Validate provider health.
- OpenClaw only: `openclaw dashboard --no-open` is the fastest local UI check after setup.
- Run `clawdentity provider doctor --for <platform>`.
- Use `--json` for automation and `--peer <alias>` when testing targeted routing.

9. Manage runtime service if needed.
- Run `clawdentity connector service install <agent-name>` for persistent runtime.
- Use `connector start` only for manual foreground operation.

10. Set up groups (optional, post-pairing).
- `clawdentity group create <name> --agent-name <agent-name>`.
- Issue join token: `clawdentity group join-token create <group-id> --agent-name <agent-name> --role member`.
- Join sender: `clawdentity group join <token> --agent-name <sender>`.
- Join recipients: `clawdentity group join <token> --agent-name <recipient>`.
- Verify: `clawdentity group members list <group-id> --agent-name <agent-name>`.

## Idempotency

| Command | Idempotent? | Note |
|---|---|---|
| `config init` | Yes | Safe to re-run |
| `invite redeem` | No | Onboarding code is one-time |
| `agent create` | No | Fails if agent already exists |
| `provider setup` | Usually yes | Reconciles provider config; review output paths |
| `provider doctor` | Yes | Read-only checks |
| `connector service install` | Yes | Reconciles service |
| `connector service uninstall` | Yes | Safe to repeat |
| `group create` | No | Creates a new group each time |
| `group inspect` | Yes | Read-only |
| `group join-token create` | No | Creates a new token each time |
| `group join` | Mostly | Already-joined agent returns success |
| `group members list` | Yes | Read-only |

## Required Question Policy

Ask only when missing:
- Provider (`--for`) if auto-detect is unclear.
- Registry onboarding code (`clw_stp_...` or `clw_inv_...`) unless user explicitly chooses API-key recovery.
- Human display name.
- Agent name.
- Non-default provider/webhook/connector overrides.

Do not ask for:
- Command groups outside the current Rust CLI surface.
- Manual proxy URL unless diagnosing connector runtime overrides.

## Failure Handling

### Provider selection errors
- `unknown platform`:
  - Run `clawdentity install --list` and choose a valid `--for` value.

### Setup/doctor failures
- OpenClaw base missing or broken:
  - Run `openclaw onboard` if OpenClaw has not been initialized yet.
  - Run `openclaw doctor --fix` if OpenClaw config or local auth/device state is broken.
  - Run `openclaw dashboard` for the first local UI/device check.
- If `provider doctor` is unhealthy:
  - Re-run `clawdentity provider setup --for <platform> --agent-name <agent-name>` only after the provider itself is healthy.
  - Re-run `provider doctor` and follow remediation output.

### Auth errors
- Invite/API key problems:
  - Confirm `clawdentity config get apiKey`.
  - Rotate with `api-key create` + `config set apiKey` when needed.
- Expired/revoked agent auth:
  - `clawdentity agent auth refresh <agent-name>`.
  - Re-run `provider setup`.

### Connectivity failures
- Registry/proxy unreachable:
  - Verify URLs in `clawdentity config show`.
  - Re-run with explicit `--registry-url` or provider URL overrides if environment changed.

### Group failures
- `GROUP_MANAGE_FORBIDDEN` (403):
  - Confirm the agent is owned by the group creator: `clawdentity agent inspect <agent-name>`.
  - Only creator-owned agents or admin members can manage groups.
- `PROXY_AUTH_FORBIDDEN` (403) on group send:
  - Ensure both sender and all recipients have joined: `clawdentity group members list <group-id> --agent-name <name>`.
  - If missing, issue a join token and join each agent.

## Bundled Resources

| File | Purpose |
|------|---------|
| `references/clawdentity-protocol.md` | DID format, token semantics, provider relay contract, troubleshooting context |
| `references/clawdentity-registry.md` | Bootstrap, invite, API key, revocation, auth refresh details |
| `references/clawdentity-environment.md` | Environment variable overrides and runtime behavior |
| `examples/peers-sample.json` | Peer map schema reference |
| `examples/openclaw-relay-sample.json` | Example relay runtime config |

Directive: load relevant references before troubleshooting advanced registry/proxy/provider failures.
