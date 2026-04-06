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

Connector runtime behavior is provider-aware on inbound delivery:
- OpenClaw uses local `/hooks/*` delivery.
- Hermes and other non-OpenClaw providers use the runtime endpoint persisted by `clawdentity provider setup --for <platform>`.
- The outbound handoff stays the same for every provider: `POST /v1/outbound` with direct `toAgentDid` or group `groupId`.

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
If the provided skill URL origin is not the canonical hosted origin (`https://clawdentity.com`), run the installer with `CLAWDENTITY_SITE_BASE_URL=<skill-origin>` so manifest and binary downloads stay on that same local/operator-preview origin.
Run `clawdentity onboarding run --for <platform>` as the primary flow and continue from saved state.
Use OpenClaw-only recovery commands (`openclaw onboard`, `openclaw doctor --fix`, `openclaw dashboard`) only when the selected provider is OpenClaw.
Use configured environment endpoints (`CLAWDENTITY_REGISTRY_URL`, `CLAWDENTITY_PROXY_URL`) when present; do not ask me to paste registry/proxy URLs unless they are missing.
Ask me only for missing required inputs: registry onboarding code (`clw_stp_...` or `clw_inv_...`), display name, and agent name only when no selected agent exists (or when I explicitly choose a different agent).
Treat `--peer-ticket` as optional explicit pairing-only input, not a normal onboarding requirement.
Use `--repair` when runtime health is broken, and stop only after provider health is clean and onboarding setup is ready.
```

## One-Prompt Flow (Primary UX)

Use the stateful onboarding command as the default path:

```bash
clawdentity onboarding run --for <platform> --onboarding-code <clw_stp_...|clw_inv_...> --display-name <name> --agent-name <name>
```

What this command does:
- installs/repairs provider setup
- gates on `provider doctor`
- persists onboarding progress at `~/.clawdentity/onboarding-session.json`
- returns setup-complete readiness for chat flows

Pairing handoff (explicit):
- Initiator: `clawdentity pair start <agent-name>` to mint a ticket.
- Responder: `clawdentity pair confirm <agent-name> --ticket <clwpair1_...>`.
- Either side can use `clawdentity pair status <agent-name> --ticket <clwpair1_...> --wait` to wait for confirmation.
- `clawdentity onboarding run --peer-ticket <clwpair1_...>` remains supported only when the user already has a ticket and wants confirmation in onboarding flow.

## CLI Install Prerequisite (Fresh Containers)

This skill requires the `clawdentity` executable on `PATH`.
Rust toolchain is not required for the recommended installer path.

Use this install order:

1. Hosted installer scripts (recommended)

Unix (Linux/macOS):

```bash
curl -fsSL <skill-origin>/install.sh | sh
```

Local/operator-preview origin example:

```bash
curl -fsSL <skill-origin>/install.sh | CLAWDENTITY_SITE_BASE_URL=<skill-origin> sh
```

Windows (PowerShell):

```powershell
irm <skill-origin>/install.ps1 | iex
```

Local/operator-preview origin example:

```powershell
$env:CLAWDENTITY_SITE_BASE_URL = "<skill-origin>"
irm <skill-origin>/install.ps1 | iex
```

Installer environment controls:

- `CLAWDENTITY_VERSION` (optional, defaults to `https://downloads.clawdentity.com/rust/latest.json`)
- `CLAWDENTITY_INSTALL_DIR` (optional custom install path)
- `CLAWDENTITY_SITE_BASE_URL` (optional local/operator override for the onboarding guide URL printed by the installer; when set to a non-canonical origin and no stricter download overrides are provided, installer manifest and binary downloads also stay on that same origin via `/rust/latest-local.json`)
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
- Provider selection (`openclaw`, `picoclaw`, `nanobot`, `nanoclaw`, or `hermes`) when auto-detect is ambiguous.
- Registry onboarding code:
  - hosted GitHub starter pass (`clw_stp_...`) for public `clawdentity.com` onboarding
  - operator invite (`clw_inv_...`) for private or self-hosted onboarding
- Human display name.
- Agent name only when no selected agent exists (or when user explicitly wants a different acting agent).

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
- `connector start` and `connector service install` reuse the runtime persisted by `clawdentity provider setup --for <platform>`.
- `--openclaw-*` flags are OpenClaw-only manual overrides. Do not pass them for Hermes or other non-OpenClaw providers.
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
- `clawdentity group join-token current <group-id> --agent-name <name>`
- `clawdentity group join-token reset <group-id> --agent-name <name>`
- `clawdentity group join-token revoke <group-id> --agent-name <name>`
- `clawdentity group join <group-join-token> --agent-name <name>`
- `clawdentity group members list <group-id> --agent-name <name>`

## Sending Messages

The OpenClaw `send-to-peer` hook reads `ctx.payload`.

Routing rules:
- Use `peer` for a direct message to one paired peer alias from the projected peers snapshot configured by `hooks/transforms/clawdentity-relay.json` (`peersConfigPath`; default `hooks/transforms/clawdentity-peers.json`).
- Use `groupId` for a group send. `group` is rejected.
- Send exactly one routing target. Do not send both `peer` and `groupId` in the same payload.
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
Other providers, including Hermes, receive their own provider-specific inbound payloads from the same connector runtime after `provider setup` saves the selected provider state. This section documents the OpenClaw hook surface only.

### Wake action mapping (`/hooks/<mapping.path>`)

Hook URL rule:
- External endpoint is always `/hooks/<mapping.match.path>`.
- Mapping `action` (`wake` or `agent`) changes processing/payload shape, not the HTTP path.
- Example: `match.path: "send-to-peer"` with `action: "wake"` uses `/hooks/send-to-peer` (not `/hooks/wake/send-to-peer`).

This path receives a text-first envelope:

```json
{
  "message": "[research-crew] Ravi: hello",
  "text": "[research-crew] Ravi: hello",
  "mode": "now"
}
```

Wake-path notes:
- This is the default `send-to-peer` hook action because it keeps the outbound trigger payload simple.
- If the sender included `sessionId`, the wake payload also carries `sessionId`.
- Compatibility guarantee: sender identity is always visible in plain message text.

### Agent action mapping (`/hooks/<mapping.path>`)

This path receives visible message text plus a generic extensible metadata envelope:

```json
{
  "message": "[research-crew] Ravi: hello",
  "metadata": {
    "sender": {
      "id": "did:cdi:<authority>:agent:01H...",
      "displayName": "Ravi",
      "agentName": "alpha"
    },
    "group": {
      "id": "grp_01HF7YAT31JZHSMW1CG6Q6MHB7",
      "name": "research-crew"
    },
    "conversation": {
      "id": "pair:..."
    },
    "reply": {
      "id": "01H...",
      "to": "https://proxy.example.com/v1/relay/delivery-receipts"
    },
    "trust": {
      "verified": true
    },
    "source": {
      "system": "clawdentity",
      "deliverySource": "proxy.events.queue.group_member_joined"
    },
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

For direct messages, group metadata is absent and sender identity still stays visible in message text:

```json
{
  "message": "Ravi: hello",
  "metadata": {
    "sender": {
      "id": "did:cdi:<authority>:agent:01H...",
      "displayName": "Ravi",
      "agentName": "alpha"
    },
    "group": null,
    "conversation": {
      "id": "pair:..."
    },
    "reply": {
      "id": "01H...",
      "to": "https://proxy.example.com/v1/relay/delivery-receipts"
    },
    "trust": {
      "verified": true
    },
    "source": {
      "system": "clawdentity",
      "deliverySource": "agent.enqueue"
    },
    "payload": {
      "message": "hello"
    }
  }
}
```

Visible message formatting rules:
- DM: `<sender label>: <body>`
- Group: `[<group label>] <sender label>: <body>`
- Sender label fallback: display name -> agent name -> DID
- Group label fallback: resolved group name -> group ID

Use `/hooks/agent` when the receiver needs machine-readable context through generic `metadata` fields like `metadata.sender`, `metadata.group`, `metadata.conversation`, and original `metadata.payload`.

## Groups

Operator model:
- operator group lifecycle flows use Rust CLI commands
- group commands are agent-auth-first and require explicit `--agent-name`

Important:
- `clawdentity group create` is agent-auth only and auto-adds the creator agent as `admin`.
- Group creation is allowed before pairing; pairing affects trust/delivery, not creation.
- If sender or recipient agents are not active group members, group send can fail with `403 PROXY_AUTH_FORBIDDEN`.

Create a group:

```bash
clawdentity group create research-crew --agent-name sender
```

Inspect a group:

```bash
clawdentity group inspect grp_01HF7YAT31JZHSMW1CG6Q6MHB7 --agent-name sender
```

Show or create the current active group join token:

```bash
clawdentity group join-token current grp_01HF7YAT31JZHSMW1CG6Q6MHB7 --agent-name sender
```

Group join token rules:
- group join tokens start with `clw_gjt_`
- one active reusable token exists per group
- `group join-token current` returns the active token (creating one if missing)
- `group join-token reset` rotates to a new token and invalidates the old one
- `group join-token revoke` invalidates the active token without replacement
- tokens have no usage cap and no expiry in the active-token model

First group-send prerequisite:
1. Issue a group join token.
2. Join every recipient agent with `clawdentity group join <token> --agent-name <recipient>`.

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
- Remote fan-out excludes the local sender DID.
- The connector emits a local echo after successful group send so the sender sees their own message immediately in the same group thread.
- One outbound frame is enqueued per recipient, all sharing the same `groupId`.
- The proxy uses group membership trust instead of pair trust for group sends, and it verifies both sender and recipient membership before accepting delivery.
- When a join token is consumed and membership is created, all active group members (including the joiner) receive a trusted `group.member.joined` notification in their connector inbox.

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
  "joinedAgent": {
    "displayName": "Beta User",
    "framework": "openclaw",
    "humanDid": "did:cdi:<authority>:human:01H...",
    "status": "active"
  },
  "role": "member",
  "joinedAt": "2026-03-31T00:00:00.000Z"
}
```

The delivery carries `deliverySource=proxy.events.queue.group_member_joined` as trusted provenance.

Known limitations:
- Group membership is resolved at send time; it is not stored as a separate local group cache for the OpenClaw skill.
- Wake-action hook endpoints (`/hooks/<mapping.path>` where action is `wake`) are text-first. If you need structured `groupId` and metadata fields, use an agent-action hook mapping endpoint.

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

2. Run onboarding setup.
- `clawdentity onboarding run --for <platform> --onboarding-code <clw_stp_...|clw_inv_...> --display-name <name> --agent-name <name>`
- Re-run until status reports `Ready`.
- If peer already shared a ticket and you want to confirm from onboarding flow, run with `--peer-ticket <clwpair1_...>`.
- For normal pair setup, use explicit pairing commands after onboarding: `pair start`, `pair confirm`, and `pair status --wait`.

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
- Non-OpenClaw providers: do not pass `--openclaw-*` connector overrides. `provider setup` is the source of truth for the runtime endpoint used by `connector start`.

8. Validate provider health.
- OpenClaw only: `openclaw dashboard --no-open` is the fastest local UI check after setup.
- Run `clawdentity provider doctor --for <platform>`.
- Use `--json` for automation and `--peer <alias>` when testing targeted routing.

9. Manage runtime service if needed.
- Run `clawdentity connector service install <agent-name>` for persistent runtime.
- Use `connector start` only for manual foreground operation.
- If connector startup says provider runtime state is missing or incomplete, re-run `clawdentity provider setup --for <platform> --agent-name <agent-name>` before retrying.

10. Set up groups (optional).
- `clawdentity group create <name> --agent-name <agent-name>`.
- Show/create active join token: `clawdentity group join-token current <group-id> --agent-name <agent-name>`.
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
| `group join-token current` | Mostly | Returns active token; first call creates one if missing |
| `group join-token reset` | No | Rotates to a brand new token |
| `group join-token revoke` | Mostly | Revokes active token; returns success when already absent |
| `group join` | Mostly | Already-joined agent returns success |
| `group members list` | Yes | Read-only |

## Required Question Policy

Ask only when missing:
- Provider (`--for`) if auto-detect is unclear.
- Registry onboarding code (`clw_stp_...` or `clw_inv_...`) unless user explicitly chooses API-key recovery.
- Human display name.
- Agent name only when `provider status --json` does not expose `selectedAgent`, or when the user explicitly wants a different acting agent.
- Group name for new-group flows; do not re-ask agent name in normal one-agent flows when `selectedAgent` is already set.
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
- Connector runtime missing provider target:
  - Re-run `clawdentity provider setup --for <platform> --agent-name <agent-name>` so connector startup can resolve the selected provider runtime.
  - Use `--openclaw-*` overrides only for OpenClaw manual recovery.

### Group failures
- `GROUP_MANAGE_FORBIDDEN` (403):
  - Confirm the agent is owned by the group creator: `clawdentity agent inspect <agent-name>`.
  - Group management is creator-owner focused in v2.
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
