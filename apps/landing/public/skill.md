---
name: clawdentity_openclaw_relay
description: This skill should be used when the user asks to "set up Clawdentity relay", "configure provider relay", "run provider doctor", "run provider relay test", "bootstrap registry", "redeem starter pass", "redeem invite", "create agent credentials", "install connector service", or needs multi-provider relay onboarding with the `clawdentity` CLI.
version: 0.5.0
---

# Clawdentity Relay Skill (Multi-Provider CLI)

This skill uses the current Rust CLI command surface and works across providers:
- OpenClaw (`openclaw`)
- PicoClaw (`picoclaw`)
- NanoBot (`nanobot`)
- NanoClaw (`nanoclaw`)

Use this skill for onboarding, provider setup, diagnostics, relay test, and connector runtime operations.

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
Set up Clawdentity relay using https://clawdentity.com/skill.md as the source of truth.
Run required onboarding end-to-end and execute commands directly.
Auto-detect provider when possible; ask me only for missing required inputs: registry onboarding code (`clw_stp_...` or `clw_inv_...`), display name, agent name, and provider only if detection is ambiguous.
```

## CLI Install Prerequisite (Fresh Containers)

This skill requires the `clawdentity` executable on `PATH`.
Rust toolchain is not required for the recommended installer path.

Use this install order:

1. Hosted installer scripts (recommended)

Unix (Linux/macOS):

```bash
curl -fsSL https://clawdentity.com/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://clawdentity.com/install.ps1 | iex
```

Installer environment controls:

- `CLAWDENTITY_VERSION` (optional, defaults to `https://downloads.clawdentity.com/rust/latest.json`)
- `CLAWDENTITY_INSTALL_DIR` (optional custom install path)
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
- `clawdentity provider status --for <openclaw|picoclaw|nanobot|nanoclaw> --json`

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
- `clawdentity invite redeem <clw_stp_...|clw_inv_...> --display-name <human-name>`
- `clawdentity invite redeem <clw_stp_...|clw_inv_...> --display-name <human-name> --registry-url <registry-url>`
- `clawdentity admin bootstrap --bootstrap-secret <secret>`
- `clawdentity admin bootstrap --bootstrap-secret <secret> --display-name <name> --api-key-name <name> --registry-url <url>`

### Agent and Auth
- `clawdentity agent create <agent-name>`
- `clawdentity agent create <agent-name> --framework <openclaw|picoclaw|nanobot|nanoclaw>`
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
- `clawdentity provider relay-test`
- `clawdentity provider relay-test --for <platform>`
- `clawdentity provider relay-test --for <platform> --peer <alias>`
- `clawdentity provider relay-test --for <platform> --message <text> --session-id <id>`
- `clawdentity provider relay-test --for <platform> --platform-base-url <url> --webhook-token <token> --connector-base-url <url>`
- `clawdentity provider relay-test --for <platform> --no-preflight`

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

## Journey (Strict Order)

1. Detect provider and local state.
- Run `clawdentity install --list --json`.
- Run `clawdentity provider status --json`.
- If ambiguous, require explicit `--for <platform>`.

2. Initialize config.
- Run `clawdentity config init` (optionally with `--registry-url`).

3. Complete onboarding.
- Preferred: `clawdentity invite redeem <clw_stp_...|clw_inv_...> --display-name <name>`.
- Recovery only: `clawdentity config set apiKey <token>` when invite is unavailable.

4. Create agent identity.
- Run `clawdentity agent create <agent-name> --framework <platform>`.
- Validate with `clawdentity agent inspect <agent-name>`.

5. Configure provider.
- OpenClaw only: if `openclaw` is missing or your OpenClaw profile is not ready, run `openclaw onboard` first.
- OpenClaw only: if `openclaw.json` or local auth/device state is broken, run `openclaw doctor --fix` before Clawdentity setup.
- Run `clawdentity provider setup --for <platform> --agent-name <agent-name>`.
- Add overrides only when defaults are wrong (`--platform-base-url`, webhook/connector args).

6. Validate provider health.
- OpenClaw only: `openclaw dashboard --no-open` is the fastest local UI check after setup.
- Run `clawdentity provider doctor --for <platform>`.
- Use `--json` for automation and `--peer <alias>` when testing targeted routing.

7. Validate relay path.
- Run `clawdentity provider relay-test --for <platform>`.
- Add `--peer <alias>` for peer-specific checks.
- Keep `--no-preflight` only for narrow debugging.

8. Manage runtime service if needed.
- Run `clawdentity connector service install <agent-name>` for persistent runtime.
- Use `connector start` only for manual foreground operation.

## Idempotency

| Command | Idempotent? | Note |
|---|---|---|
| `config init` | Yes | Safe to re-run |
| `invite redeem` | No | Onboarding code is one-time |
| `agent create` | No | Fails if agent already exists |
| `provider setup` | Usually yes | Reconciles provider config; review output paths |
| `provider doctor` | Yes | Read-only checks |
| `provider relay-test` | Mostly yes | Sends real probe traffic |
| `connector service install` | Yes | Reconciles service |
| `connector service uninstall` | Yes | Safe to repeat |

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

## Bundled Resources

| File | Purpose |
|------|---------|
| `references/clawdentity-protocol.md` | DID format, token semantics, provider relay contract, troubleshooting context |
| `references/clawdentity-registry.md` | Bootstrap, invite, API key, revocation, auth refresh details |
| `references/clawdentity-environment.md` | Environment variable overrides and runtime behavior |
| `examples/peers-sample.json` | Peer map schema reference |
| `examples/openclaw-relay-sample.json` | Example relay runtime config |

Directive: load relevant references before troubleshooting advanced registry/proxy/provider failures.

---

# Appended References

---

## Clawdentity Protocol Reference

Source: `apps/openclaw-skill/skill/references/clawdentity-protocol.md`

# Clawdentity Relay Protocol Reference

## Purpose

Define the exact runtime contract used by `relay-to-peer.mjs`.

> Rust CLI note: executable commands for this skill live in `SKILL.md` (`clawdentity install`, `clawdentity provider ...`, `clawdentity connector ...`). Pairing is documented here as a proxy API flow.

## Filesystem Paths

Canonical paths are defined in SKILL.md § Filesystem Truth. Refer there for all path contracts.

## Setup Input Contract

`clawdentity provider setup --for openclaw --agent-name <agent-name>` is self-setup only. It does not accept peer routing fields.

Rules:
- setup must succeed without any peer metadata
- peers config snapshot still exists and may be empty until pairing is completed
- setup assumes OpenClaw itself is already healthy and only layers Clawdentity relay assets on top

## Peer Map Schema

`~/.clawdentity/peers.json` must be valid JSON:

```json
{
  "peers": {
    "beta": {
      "did": "did:cdi:<authority>:agent:01H...",
      "proxyUrl": "https://beta-proxy.example.com/hooks/agent",
      "agentName": "beta",
      "humanName": "Ira"
    }
  }
}
```

Rules:
- peer alias key uses `[a-zA-Z0-9._-]`
- `did` required and must be a valid DID v2 agent identifier (`did:cdi:<authority>:agent:<ulid>`)
- `proxyUrl` required and must be a valid absolute URL
- `agentName` optional
- `humanName` optional

## Proxy Pairing Prerequisite

Relay delivery policy is trust-pair based on proxy side. Pairing must be completed before first cross-agent delivery.

Current pairing contract is ticket-based at proxy API level:

1. Initiator owner starts pairing:
   - proxy route: `POST /pair/start`
   - headers:
     - `Authorization: Claw <AIT>`
     - ownership validation is handled internally by proxy-to-registry service auth
   - body:

```json
{
  "ttlSeconds": 300,
  "initiatorProfile": {
    "agentName": "alpha",
    "humanName": "Ravi"
  }
}
```

> **Agent note:** `initiatorProfile` should be derived by the pairing client from local identity/config state when available.

2. Responder confirms pairing:
   - proxy route: `POST /pair/confirm`
   - headers:
     - `Authorization: Claw <AIT>`
   - body:

```json
{
  "ticket": "clwpair1_...",
  "responderProfile": {
    "agentName": "beta",
    "humanName": "Ira"
  }
}
```

> **Agent note:** `responderProfile` should be derived by the pairing client from local identity/config state when available.

Rules:
- `ticket` is one-time and expires (default 5 minutes, max 15 minutes).
- Confirm establishes mutual trust for the initiator/responder pair.
- Confirm auto-persists peer DID/proxy mapping locally in `~/.clawdentity/peers.json` using ticket issuer metadata.
- Same-agent sender/recipient is allowed by policy without explicit pair entry.

## Relay Input Contract

The OpenClaw transform reads `ctx.payload`.

- If `payload.peer` is absent:
  - return payload unchanged
  - do not relay
- If `payload.peer` exists:
  - resolve peer from `peers.json`
  - remove `peer` from forwarded body
  - send JSON POST to local connector outbound endpoint
  - return `null` to skip local handling

## Relay Agent Selection Contract

Relay resolves local agent name in this order:
1. transform option `agentName`
2. `CLAWDENTITY_AGENT_NAME`
3. `~/.clawdentity/openclaw-agent-name`
4. single local agent fallback from `~/.clawdentity/agents/`

## Local OpenClaw Base URL Contract

`~/.clawdentity/openclaw-relay.json` stores the OpenClaw upstream base URL used by local proxy runtime fallback:

```json
{
  "openclawBaseUrl": "http://127.0.0.1:18789",
  "openclawHookToken": "<auto-provisioned-token>",
  "updatedAt": "2026-02-15T20:00:00.000Z"
}
```

Rules:
- `openclawBaseUrl` must be absolute `http` or `https`.
- `openclawHookToken` is optional in schema but should be present after `clawdentity provider setup --for openclaw --agent-name <agent-name>`; connector runtime uses it for `/hooks/*` auth when no explicit hook token option/env is provided.
- `updatedAt` is ISO-8601 UTC timestamp.
- Proxy runtime precedence is: `OPENCLAW_BASE_URL` env first, then `openclaw-relay.json`, then built-in default.

## Connector Handoff Contract

The transform does not send directly to the peer proxy. It posts to the local connector runtime:
- Endpoint candidates are loaded from OpenClaw-local `hooks/transforms/clawdentity-relay.json` (generated by provider setup for OpenClaw) and attempted in order.
- Default fallback endpoint remains `http://127.0.0.1:19400/v1/outbound`.
- Runtime may also use:
  - `CLAWDENTITY_CONNECTOR_BASE_URL`
  - `CLAWDENTITY_CONNECTOR_OUTBOUND_PATH`
- `provider setup --for openclaw --agent-name <agent-name>` is the primary self-setup path after OpenClaw itself is healthy.
- `connector start <agent-name>` is advanced/manual recovery; it resolves bind URL from `~/.clawdentity/openclaw-connectors.json` when explicit env override is absent.

Outbound JSON body sent by transform:

```json
{
  "peer": "beta",
  "peerDid": "did:cdi:<authority>:agent:01H...",
  "peerProxyUrl": "https://beta-proxy.example.com/hooks/agent",
  "payload": {
    "event": "agent.message"
  }
}
```

Rules:
- `payload.peer` is removed before creating the `payload` object above.
- Transform sends `Content-Type: application/json` only.
- Connector runtime is responsible for Clawdentity auth headers and request signing when calling peer proxy.

## Error Conditions

Relay fails when:
- no selected local agent can be resolved
- peer alias missing from config
- local connector outbound endpoint is unavailable (`404`)
- local connector reports unknown peer alias (`409`)
- local connector rejects payload (`400` or `422`)
- local connector outbound request fails (network/other non-2xx)

Error messages should include file/path context but never print secret content.

## Proxy URL Resolution

CLI resolves proxy URL in this order (first non-empty wins):

1. `CLAWDENTITY_PROXY_URL` environment variable
2. `proxyUrl` from `~/.clawdentity/config.json`
3. Registry metadata from `GET /v1/metadata`
4. Error when configured proxy does not match metadata (`CLI_PAIR_PROXY_URL_MISMATCH`) or metadata lookup fails

> **Agent note:** Proxy URL resolution is fully automatic. Do not ask the user for a proxy URL. The CLI resolves it from env, config, or registry metadata without user input.

### Metadata expectation

Registry metadata (`/v1/metadata`) should return a valid `proxyUrl`.

Known defaults:

| Registry URL | Metadata proxy URL |
|-------------|--------------------|
| `https://registry.clawdentity.com` | `https://proxy.clawdentity.com` |
| `https://dev.registry.clawdentity.com` | `https://dev.proxy.clawdentity.com` |

Recovery: rerun onboarding (`clawdentity invite redeem <clw_stp_...|clw_inv_...> --display-name <human-name>`) so local config aligns to registry metadata.

## Identity Injection

When identity injection is enabled (proxy env `INJECT_IDENTITY_INTO_MESSAGE`, default `true`), the proxy prepends an identity block to the `message` field of relayed payloads.

### Block format

```
[Clawdentity Identity]
agentDid: did:cdi:<authority>:agent:01H...
ownerDid: did:cdi:<authority>:human:01H...
issuer: https://registry.clawdentity.com
aitJti: 01H...
```

The block is separated from the original message by a blank line (`\n\n`).

### Field definitions

| Field | Description |
|---|---|
| `agentDid` | Sender agent DID — use to identify the peer |
| `ownerDid` | DID of the human who owns the sender agent |
| `issuer` | Registry URL that issued the sender's AIT |
| `aitJti` | Unique JTI claim from the sender's AIT |

### Programmatic access

The connector `deliver` frame includes `fromAgentDid` as a top-level field. Inbound inbox items (`ConnectorInboundInboxItem`) also expose `fromAgentDid` for programmatic sender identification without parsing the identity block.

## Pairing Error Codes

### `pair start` errors

| HTTP Status | Error Code | Meaning | Recovery |
|---|---|---|---|
| 403 | `PROXY_PAIR_OWNERSHIP_FORBIDDEN` | Initiator ownership check failed | Recreate/refresh the local agent identity |
| 503 | `PROXY_PAIR_OWNERSHIP_UNAVAILABLE` | Registry ownership lookup unavailable | Ensure registry deterministic bootstrap credentials are configured (`BOOTSTRAP_INTERNAL_SERVICE_ID`, `BOOTSTRAP_INTERNAL_SERVICE_SECRET`) and proxy credentials match (`BOOTSTRAP_INTERNAL_SERVICE_ID`, `BOOTSTRAP_INTERNAL_SERVICE_SECRET`); for existing envs rotate credentials together |
| — | `CLI_PAIR_AGENT_NOT_FOUND` | Agent ait.jwt or secret.key missing/empty | Run `agent create` or `agent auth refresh` |
| — | `CLI_PAIR_HUMAN_NAME_MISSING` | Local config is missing `humanName` | Set via `invite redeem` or config |
| — | `CLI_PAIR_PROXY_URL_INVALID` | Configured proxy URL is malformed | Fix proxy URL: `clawdentity config set proxyUrl <url>` |
| — | `CLI_PAIR_START_INVALID_TTL` | ttlSeconds must be a positive integer | Use valid `--ttl-seconds` value |
| — | `CLI_PAIR_INVALID_PROXY_URL` | Proxy URL is invalid | Fix proxy URL in config |
| — | `CLI_PAIR_REQUEST_FAILED` | Unable to connect to proxy URL | Check DNS, firewall, proxy URL |
| — | `CLI_PAIR_START_FAILED` | Generic pair start failure | Retry; check proxy connectivity |
| — | `CLI_PAIR_PROFILE_INVALID` | Name too long, contains control characters, or empty | Fix agent or human name |

### `pair confirm` errors

| HTTP Status | Error Code | Meaning | Recovery |
|---|---|---|---|
| 404 | `PROXY_PAIR_TICKET_NOT_FOUND` | Pairing ticket is invalid or expired | Request new ticket from initiator |
| 410 | `PROXY_PAIR_TICKET_EXPIRED` | Pairing ticket has expired | Request new ticket |
| — | `CLI_PAIR_CONFIRM_TICKET_REQUIRED` | Either --ticket or --qr-file is required | Provide one input path |
| — | `CLI_PAIR_CONFIRM_INPUT_CONFLICT` | Cannot provide both --ticket and --qr-file | Use one input path only |
| — | `CLI_PAIR_CONFIRM_TICKET_INVALID` | Pairing ticket is invalid | Get new ticket from initiator |
| — | `CLI_PAIR_CONFIRM_QR_FILE_NOT_FOUND` | QR file not found | Verify file path |
| — | `CLI_PAIR_CONFIRM_QR_NOT_FOUND` | No pairing QR code found in image | Request new QR from initiator |
| — | `CLI_PAIR_CONFIRM_FAILED` | Generic pair confirm failure | Retry with new ticket |
| — | `CLI_PAIR_CONFIRM_QR_FILE_INVALID` | QR image file corrupt or unsupported | Request new QR from initiator |
| — | `CLI_PAIR_CONFIRM_QR_FILE_REQUIRED` | QR path unusable | Verify file path and format |
| — | `CLI_PAIR_TICKET_ISSUER_MISMATCH` | Ticket issuer does not match configured proxy URL | `clawdentity config set proxyUrl <issuer-url>` and retry |

### `pair status` errors

| HTTP Status | Error Code | Meaning | Recovery |
|---|---|---|---|
| — | `CLI_PAIR_STATUS_FAILED` | Generic pair status failure | Retry |
| — | `CLI_PAIR_STATUS_WAIT_TIMEOUT` | Wait polling timed out | Generate a new ticket via `POST /pair/start` |
| — | `CLI_PAIR_STATUS_FORBIDDEN` | 403 on status check — ownership mismatch | Verify correct agent |
| — | `CLI_PAIR_STATUS_TICKET_REQUIRED` | Missing ticket argument | Provide `--ticket <clwpair1_...>` |
| — | `CLI_PAIR_STATUS_WAIT_INVALID` | Wait/poll option is not a positive integer | Use a valid positive integer for `--wait-seconds` or `--poll-interval-seconds` |
| — | `CLI_PAIR_TICKET_ISSUER_MISMATCH` | Ticket issuer does not match configured proxy URL | `clawdentity config set proxyUrl <issuer-url>` and retry |

### Peer persistence errors

| Error Code | Meaning | Recovery |
|---|---|---|
| `CLI_PAIR_PEERS_CONFIG_INVALID` | `peers.json` corrupt or invalid structure | Delete `peers.json` and re-pair |
| `CLI_PAIR_PEER_ALIAS_INVALID` | Derived alias fails validation | Re-pair with valid agent DID |

## Cache Files

| Path | TTL | Used By |
|------|-----|---------|
| `~/.clawdentity/cache/registry-keys.json` | 1 hour | token validation/auth routines — cached registry signing public keys |
| `~/.clawdentity/cache/crl-claims.json` | 15 minutes | token validation/auth routines — cached certificate revocation list |

Cache is populated on first token validation/auth call and refreshed when TTL expires. Stale cache is used as fallback when registry is unreachable.

## Peer Alias Derivation

When `pair confirm` saves a new peer, alias is derived automatically:

1. Parse peer DID with the protocol DID parser and extract the identifier component.
2. Take last 8 characters of the identifier, lowercase: `peer-<last8>`.
3. If alias already exists in `peers.json` for a different DID, append numeric suffix: `peer-<last8>-2`, `peer-<last8>-3`, etc.
4. If peer DID already exists in `peers.json`, reuse existing alias (no duplicate entry).
5. Fallback alias is `peer` if DID is not a valid agent DID.

Alias validation: `[a-zA-Z0-9._-]`, max 128 characters.

## Container Environments

When running in Docker or similar container runtimes:

- `provider setup --for openclaw` writes Docker-aware endpoint candidates into `clawdentity-relay.json`:
  - `host.docker.internal`, `gateway.docker.internal`, Linux bridge (`172.17.0.1`), default gateway, and loopback.
  - Candidates are attempted in order by the relay transform.
- Use provider setup options plus connector service controls when the connector runs as a separate container or process.
- Required env overrides for container networking:
  - `OPENCLAW_BASE_URL` — point to OpenClaw inside/outside the container network.
  - `CLAWDENTITY_CONNECTOR_BASE_URL` — point to the connector's bind address from the transform's perspective.
- Port allocation: each agent gets its own connector port starting from `19400`.
  - Port assignment is tracked in `~/.clawdentity/openclaw-connectors.json`.

## Doctor Check Reference

Run `clawdentity provider doctor --for openclaw --json` for machine-readable diagnostics.

| Check ID | Validates | Remediation on Failure |
|---|---|---|
| `config.registry` | `registryUrl`, `apiKey`, and `proxyUrl` in config (or proxy env override) | `clawdentity config init` or `invite redeem` |
| `state.openclawConfig` | `openclaw.json` exists and is readable | `openclaw onboard` or `openclaw doctor --fix` |
| `state.selectedAgent` | Agent marker at `~/.clawdentity/openclaw-agent-name` | `clawdentity provider setup --for openclaw --agent-name <agent-name>` |
| `state.credentials` | `ait.jwt` and `secret.key` exist and non-empty | `clawdentity agent create <agent-name>` or `agent auth refresh <agent-name>` |
| `state.peers` | Peers config valid; requested `--peer` alias exists | Populate peers via pairing API flow |
| `state.transform` | Relay transform artifacts in OpenClaw hooks dir | `clawdentity provider setup --for openclaw --agent-name <agent-name>` after OpenClaw is healthy |
| `state.skillArtifacts` | OpenClaw skill docs and relay bundle are installed | `clawdentity install --for openclaw` or `clawdentity provider setup --for openclaw --agent-name <agent-name>` |
| `state.hookMapping` | `send-to-peer` hook mapping in OpenClaw config | `clawdentity provider setup --for openclaw --agent-name <agent-name>` after OpenClaw is healthy |
| `state.hookToken` | Hooks enabled with token in OpenClaw config | `clawdentity provider setup --for openclaw --agent-name <agent-name>` after OpenClaw is healthy, then restart OpenClaw if needed |
| `state.hookSessionRouting` | `hooks.defaultSessionKey`, `hooks.allowRequestSessionKey=false`, and required prefixes | `clawdentity provider setup --for openclaw --agent-name <agent-name>` after OpenClaw is healthy |
| `state.gatewayAuth` | OpenClaw `gateway.auth` readiness for the current auth mode | `openclaw onboard` or `openclaw doctor --fix` |
| `state.gatewayDevicePairing` | Pending OpenClaw device approvals | `openclaw dashboard` |
| `state.relayRuntime` | Clawdentity relay runtime metadata has the hook token needed by the connector | `clawdentity provider setup --for openclaw --agent-name <agent-name>` after OpenClaw is healthy |
| `state.connectorRuntime` | Local connector runtime reachable and websocket-connected | `clawdentity connector service install <agent-name>` or manual `clawdentity connector start <agent-name>` |
| `state.connectorInboundInbox` | Connector local inbound inbox backlog and replay queue state | Verify connector runtime health, then replay or clear backlog as needed |
| `state.openclawHookHealth` | Connector replay status for local OpenClaw hook delivery | Restart OpenClaw and the connector runtime, then retry delivery |

---

## Clawdentity Registry Reference

Source: `apps/openclaw-skill/skill/references/clawdentity-registry.md`

# Clawdentity Registry Operations Reference

## Purpose

Document registry-side CLI commands that are outside the core relay setup journey: admin bootstrap, API key lifecycle, agent revocation, and auth refresh.

## Admin Bootstrap

Bootstrap creates the first admin human and API key on a fresh registry. This is a prerequisite before any invites can be created.

### Command

```
clawdentity admin bootstrap --bootstrap-secret <secret>
```

### Flags

| Flag | Required | Description |
|------|----------|-------------|
| `--bootstrap-secret <secret>` | Yes | One-time bootstrap secret configured on registry server |
| `--display-name <name>` | No | Admin display name |
| `--api-key-name <name>` | No | Admin API key label |
| `--registry-url <url>` | No | Override registry URL |

### Expected Output

```
Admin bootstrap completed
Human DID: did:cdi:<authority>:human:01H...
API key name: <name>
API key token (shown once):
<token>
Internal service ID: <id>
Internal service name: proxy-pairing
Set proxy secrets BOOTSTRAP_INTERNAL_SERVICE_ID and BOOTSTRAP_INTERNAL_SERVICE_SECRET manually in Cloudflare before proxy deploy.
API key saved to local config
```

### Error Codes

| Error Code | Meaning |
|------------|---------|
| `ADMIN_BOOTSTRAP_DISABLED` | Bootstrap is disabled on the registry |
| `ADMIN_BOOTSTRAP_UNAUTHORIZED` | Bootstrap secret is invalid |
| `ADMIN_BOOTSTRAP_ALREADY_COMPLETED` | Admin already exists; bootstrap is one-time |
| `ADMIN_BOOTSTRAP_INVALID` | Request payload is invalid |
| `CLI_ADMIN_BOOTSTRAP_SECRET_REQUIRED` | Bootstrap secret was not provided |
| `CLI_ADMIN_BOOTSTRAP_INVALID_REGISTRY_URL` | Registry URL is invalid |
| `CLI_ADMIN_BOOTSTRAP_REQUEST_FAILED` | Unable to connect to registry |
| `CLI_ADMIN_BOOTSTRAP_CONFIG_PERSISTENCE_FAILED` | Failed to save admin credentials locally |

### Behavioral Notes

- One-time operation: succeeds only on first call per registry.
- Automatically persists `registryUrl` and `apiKey` to local config.
- Registry must have `BOOTSTRAP_SECRET` environment variable set.
- Registry must also have deterministic service credentials configured:
  - `BOOTSTRAP_INTERNAL_SERVICE_ID`
  - `BOOTSTRAP_INTERNAL_SERVICE_SECRET`
- `BOOTSTRAP_INTERNAL_SERVICE_ID` must match proxy `BOOTSTRAP_INTERNAL_SERVICE_ID`.
- `BOOTSTRAP_INTERNAL_SERVICE_SECRET` must match proxy `BOOTSTRAP_INTERNAL_SERVICE_SECRET`.
- After bootstrap, admin can create invites with `clawdentity invite create`.

## API Key Lifecycle

### Create API key

```
clawdentity api-key create
```

Creates a new API key under the current authenticated human. Token is displayed once.

### List API keys

```
clawdentity api-key list
```

Lists all API keys for the current human with ID, name, and status.

### Revoke API key

```
clawdentity api-key revoke <api-key-id>
```

Revokes an API key by ID. The key becomes immediately unusable.

### Rotation workflow

1. `clawdentity api-key create` — note the new token.
2. `clawdentity config set apiKey <new-token>` — switch local config.
3. `clawdentity api-key revoke <old-key-id>` — deactivate old key.
4. `clawdentity config get apiKey` — verify new key is active.

### Error Codes

| HTTP Status | Meaning |
|-------------|---------|
| 401 | API key invalid or expired; re-authenticate |
| 403 | Insufficient permissions (admin required for some operations) |

## Agent Revocation

### Command

```
clawdentity agent auth revoke <agent-name>
```

Revokes a local agent identity via the registry. The agent's AIT will appear on the certificate revocation list (CRL).

### Behavioral Notes

- Reads agent DID from `~/.clawdentity/agents/<agent-name>/identity.json`.
- Requires `apiKey` configured in `~/.clawdentity/config.json`.
- Idempotent: repeat revocation calls succeed without error.
- CRL propagation lag: verifiers using cached `crl-claims.json` (15-minute TTL) may not see revocation immediately.
- Local credential files are not deleted; only registry-side revocation is performed.

### Error Codes

| HTTP Status | Meaning |
|-------------|---------|
| 401 | Authentication failed — API key invalid |
| 404 | Agent not found in registry |
| 409 | Agent cannot be revoked (already revoked or conflict) |

## Agent Auth Refresh

### Command

```
clawdentity agent auth refresh <agent-name>
```

Refreshes the agent's registry auth credentials using Claw proof (Ed25519 signature).

### What It Reads

- `~/.clawdentity/agents/<agent-name>/secret.key` — for signing the proof
- `~/.clawdentity/agents/<agent-name>/registry-auth.json` — current refresh token

### What It Writes

- `~/.clawdentity/agents/<agent-name>/registry-auth.json` — new access token and refresh token

### Behavioral Notes

- Uses atomic write (temp file + chmod 0600 + rename) to prevent corruption.
- Requires `registryUrl` configured in `~/.clawdentity/config.json`.
- After refresh, restart connector to pick up new credentials.
- If `registry-auth.json` is missing or empty, the agent must be re-created with `agent create`.

### Error Codes

| Error Code | Meaning |
|------------|---------|
| `CLI_OPENCLAW_EMPTY_AGENT_CREDENTIALS` | Registry auth file is empty or missing |
| 401 | Refresh token expired or invalid — re-create agent |

## Invite Management (Admin)

### Create invite

```
clawdentity invite create
clawdentity invite create --expires-at <iso-8601> --registry-url <url>
```

Admin-only. Creates a registry invite code (`clw_inv_...`) for onboarding new users.

Hosted `clawdentity.com` onboarding can also issue GitHub starter passes (`clw_stp_...`). Both starter passes and invites redeem through the same CLI command:

```bash
clawdentity invite redeem <clw_stp_...|clw_inv_...> --display-name "Your Name"
```

### Error Codes

| Error Code | Meaning |
|------------|---------|
| `CLI_INVITE_MISSING_LOCAL_CREDENTIALS` | API key not configured |
| `CLI_INVITE_CREATE_FAILED` | Invite creation failed |
| 401 | Authentication failed |
| 403 | Requires admin access |
| 400 | Invalid request |

## Connector Errors

| Error Code | Meaning | Recovery |
|---|---|---|
| `CLI_CONNECTOR_SERVICE_PLATFORM_INVALID` | Invalid platform argument | Use `auto`, `launchd`, or `systemd` |
| `CLI_CONNECTOR_SERVICE_PLATFORM_UNSUPPORTED` | OS unsupported for selected platform | Use a supported platform (macOS: launchd, Linux: systemd) |
| `CLI_CONNECTOR_SERVICE_INSTALL_FAILED` | Service install failed | Check permissions, systemd/launchd status |
| `CLI_CONNECTOR_PROXY_URL_REQUIRED` | Proxy URL unresolvable | Run `invite redeem` with your starter pass or invite, or set `CLAWDENTITY_PROXY_URL` / `CLAWDENTITY_PROXY_WS_URL` |
| `CLI_CONNECTOR_INVALID_REGISTRY_AUTH` | `registry-auth.json` corrupt or invalid | Run `clawdentity agent auth refresh <agent-name>` |
| `CLI_CONNECTOR_INVALID_AGENT_IDENTITY` | `identity.json` corrupt or invalid | Re-create agent with `clawdentity agent create <agent-name>` |

---

## Clawdentity Environment Reference

Source: `apps/openclaw-skill/skill/references/clawdentity-environment.md`

# Clawdentity Environment Variable Reference

## Purpose

Complete reference for CLI environment variable overrides. When env overrides are present, config-file URL mismatches are not blockers.

## CLI Environment Variables

| Variable | Purpose | Used By |
|---|---|---|
| `CLAWDENTITY_PROXY_URL` | Override proxy URL | pair, connector |
| `CLAWDENTITY_PROXY_WS_URL` | Override proxy WebSocket URL | connector |
| `CLAWDENTITY_REGISTRY_URL` | Override registry URL | config |
| `CLAWDENTITY_CONNECTOR_BASE_URL` | Override connector bind URL | connector |
| `CLAWDENTITY_CONNECTOR_OUTBOUND_PATH` | Override outbound path | relay transform |
| `CLAWDENTITY_AGENT_NAME` | Override agent name resolution | provider (`--for openclaw`), transform |
| `OPENCLAW_BASE_URL` | Override OpenClaw upstream URL | provider setup (`--for openclaw`) |
| `OPENCLAW_HOOK_TOKEN` | Override hook auth token | provider setup (`--for openclaw`) |
| `OPENCLAW_GATEWAY_TOKEN` | Override OpenClaw gateway token auth | OpenClaw-owned gateway auth |
| `OPENCLAW_CONFIG_PATH` | Override OpenClaw config file path | provider (`--for openclaw`) |
| `OPENCLAW_STATE_DIR` | Override OpenClaw state directory | provider (`--for openclaw`) |
| `OPENCLAW_HOME` | Override OpenClaw home directory (used when explicit config/state overrides are unset) | provider (`--for openclaw`) |

## Profile-Local State Resolution

In profile-mounted/containerized OpenClaw environments, Clawdentity state may be stored at:
- `<openclaw-state>/.clawdentity`

instead of:
- `~/.clawdentity`

If `~/.clawdentity` is missing but `<openclaw-state>/.clawdentity` exists, run CLI commands with:
- `HOME=<openclaw-state>`

This makes `clawdentity` resolve the correct profile-local state root.

## Proxy Server Environment Variables

These variables configure the Clawdentity proxy server (operator-facing, not CLI):

| Variable | Purpose | Default |
|---|---|---|
| `INJECT_IDENTITY_INTO_MESSAGE` | Enable/disable identity block injection into relayed messages | `true` |
| `RELAY_QUEUE_MAX_MESSAGES_PER_AGENT` | Max queued messages per agent | `500` |
| `RELAY_QUEUE_TTL_SECONDS` | Queue message time-to-live | `3600` |
| `RELAY_RETRY_INITIAL_MS` | Initial retry delay for relay delivery | `1000` |
