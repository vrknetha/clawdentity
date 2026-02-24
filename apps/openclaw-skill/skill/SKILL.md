---
name: clawdentity_openclaw_relay
description: This skill should be used when the user asks to "set up Clawdentity relay", "configure provider relay", "run provider doctor", "run provider relay test", "bootstrap registry", "redeem invite", "create agent credentials", "install connector service", or needs multi-provider relay onboarding with the Rust `clawdentity` CLI.
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
- `https://raw.githubusercontent.com/vrknetha/clawdentity/develop/apps/openclaw-skill/skill/SKILL.md`

For deterministic automation, pin the URL to a release tag or commit SHA instead of `develop`.

## Scope Guard

This skill is command-accurate for the Rust CLI (`clawdentity 0.1.x`).
Node/TypeScript CLI usage is deprecated for this skill and out of scope.

Do not instruct deprecated command groups that are not present in the Rust CLI:
- `clawdentity openclaw ...`
- `clawdentity pair ...`
- `clawdentity verify ...`
- `clawdentity skill install ...`

## CLI Install Prerequisite (Fresh Containers)

This skill assumes the Rust CLI executable (`clawdentity`) is already available on `PATH`.
If it is missing, install it first.

Preferred release binary flow:
- Linux/macOS:
  - Download `clawdentity-<version>-linux-x86_64.tar.gz`, `clawdentity-<version>-linux-aarch64.tar.gz`, `clawdentity-<version>-macos-x86_64.tar.gz`, or `clawdentity-<version>-macos-aarch64.tar.gz`
  - Extract and place `clawdentity` in a `PATH` directory
- Windows:
  - Download `clawdentity-<version>-windows-x86_64.zip`
  - Extract and place `clawdentity.exe` in a `PATH` directory

PowerShell example (Windows download/install via `irm`):

```powershell
$tag = "rust/vX.Y.Z"
$version = "X.Y.Z"
$asset = "clawdentity-$version-windows-x86_64.zip"
$url = "https://github.com/vrknetha/clawdentity/releases/download/$tag/$asset"

irm $url -OutFile $asset
Expand-Archive -Path $asset -DestinationPath ".\\clawdentity-bin" -Force
New-Item -ItemType Directory -Force -Path "$HOME\\bin" | Out-Null
Move-Item ".\\clawdentity-bin\\clawdentity.exe" "$HOME\\bin\\clawdentity.exe" -Force
```

Cargo fallback (if prebuilt binary is unavailable):

```bash
cargo install --locked clawdentity-cli
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
- Invite code (`clw_inv_...`) for standard onboarding.
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
- `clawdentity invite redeem <clw_inv_...> --display-name <human-name>`
- `clawdentity invite redeem <clw_inv_...> --display-name <human-name> --registry-url <registry-url>`
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
- Preferred: `clawdentity invite redeem <clw_inv_...> --display-name <name>`.
- Recovery only: `clawdentity config set apiKey <token>` when invite is unavailable.

4. Create agent identity.
- Run `clawdentity agent create <agent-name> --framework <platform>`.
- Validate with `clawdentity agent inspect <agent-name>`.

5. Configure provider.
- Run `clawdentity provider setup --for <platform> --agent-name <agent-name>`.
- Add overrides only when defaults are wrong (`--platform-base-url`, webhook/connector args).

6. Validate provider health.
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
| `invite redeem` | No | Invite is one-time |
| `agent create` | No | Fails if agent already exists |
| `provider setup` | Usually yes | Reconciles provider config; review output paths |
| `provider doctor` | Yes | Read-only checks |
| `provider relay-test` | Mostly yes | Sends real probe traffic |
| `connector service install` | Yes | Reconciles service |
| `connector service uninstall` | Yes | Safe to repeat |

## Required Question Policy

Ask only when missing:
- Provider (`--for`) if auto-detect is unclear.
- Invite code (`clw_inv_...`) unless user explicitly chooses API-key recovery.
- Human display name.
- Agent name.
- Non-default provider/webhook/connector overrides.

Do not ask for:
- Deprecated command paths (`openclaw`, `pair`, `verify`, `skill install`).
- Manual proxy URL unless diagnosing connector runtime overrides.

## Failure Handling

### Provider selection errors
- `unknown platform`:
  - Run `clawdentity install --list` and choose a valid `--for` value.

### Setup/doctor failures
- If `provider doctor` is unhealthy:
  - Re-run `clawdentity provider setup --for <platform> --agent-name <agent-name>`.
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
