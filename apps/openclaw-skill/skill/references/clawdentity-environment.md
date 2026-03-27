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
| `INJECT_IDENTITY_INTO_MESSAGE` | Enable/disable legacy identity block injection into relayed messages | `false` |
| `RELAY_QUEUE_MAX_MESSAGES_PER_AGENT` | Max queued messages per agent | `500` |
| `RELAY_QUEUE_TTL_SECONDS` | Queue message time-to-live | `3600` |
| `RELAY_RETRY_INITIAL_MS` | Initial retry delay for relay delivery | `1000` |
