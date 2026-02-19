# clawdentity

CLI for Clawdentity — cryptographic identity layer for AI agent-to-agent trust.

[![npm version](https://img.shields.io/npm/v/clawdentity.svg)](https://www.npmjs.com/package/clawdentity)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/vrknetha/clawdentity/blob/main/LICENSE)
![Node 22+](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)

## Install

```bash
npm install -g clawdentity
```

## Quick Start

Have an invite code (`clw_inv_...`) ready, then prompt your OpenClaw agent:

> Set up Clawdentity relay

The agent runs the full onboarding sequence — install, identity creation, relay configuration, and readiness checks.

<details>
<summary>Manual CLI setup</summary>

```bash
# Initialize config
clawdentity config init

# Redeem an invite (sets API key)
clawdentity invite redeem <code> --display-name "Your Name"

# Create an agent identity
clawdentity agent create <name> --framework openclaw

# Configure the relay
clawdentity openclaw setup <name>

# Install the skill artifact
clawdentity skill install

# Verify everything works
clawdentity openclaw doctor
```

</details>

## Commands

| Command | Description |
|---------|-------------|
| `config init` | Initialize local config |
| `config set <key> <value>` | Set a config value |
| `config get <key>` | Get a config value |
| `config show` | Show all resolved config |
| `invite redeem <code>` | Redeem invite, store API key |
| `invite create` | Create invite (admin) |
| `agent create <name>` | Generate + register agent identity |
| `agent inspect <name>` | Show agent AIT metadata |
| `agent auth refresh <name>` | Refresh registry auth credentials |
| `agent revoke <name>` | Revoke agent identity |
| `api-key create` | Create personal API key |
| `api-key list` | List personal API keys |
| `api-key revoke <id>` | Revoke API key |
| `openclaw setup <name>` | Configure OpenClaw relay |
| `openclaw doctor` | Validate relay health |
| `openclaw relay test` | Test peer relay delivery |
| `pair start <name>` | Initiate QR pairing |
| `pair confirm <name>` | Confirm peer pairing |
| `pair status <name>` | Poll pairing status |
| `skill install` | Install skill artifacts |
| `connector start <name>` | Start connector runtime |
| `connector service install <name>` | Auto-start service at login |
| `connector service uninstall <name>` | Remove auto-start service |
| `verify <tokenOrFile>` | Verify AIT against registry |
| `admin bootstrap` | Bootstrap first admin |

## Configuration

Config files are stored in `~/.clawdentity/`.

| Key | Environment Variable | Description |
|-----|---------------------|-------------|
| `registryUrl` | `CLAWDENTITY_REGISTRY_URL` | Identity registry URL |
| `proxyUrl` | `CLAWDENTITY_PROXY_URL` | Verification proxy URL |
| `apiKey` | `CLAWDENTITY_API_KEY` | API key (set by `invite redeem`) |
| `humanName` | `CLAWDENTITY_HUMAN_NAME` | Display name for invites |

Environment variables override values in the config file.

## Requirements

- Node >= 22

## License

[MIT](https://github.com/vrknetha/clawdentity/blob/main/LICENSE)
