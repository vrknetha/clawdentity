# Clawdentity Relay Protocol Reference

## Purpose

Define the exact runtime contract used by `relay-to-peer.mjs`.

## Filesystem Paths

### OpenClaw files
- `<resolved-openclaw-state>/openclaw.json` (legacy filenames may exist: `clawdbot.json`, `moldbot.json`, `moltbot.json`)
- `<resolved-openclaw-state>/hooks/transforms/relay-to-peer.mjs`
- `<resolved-openclaw-state>/hooks/transforms/clawdentity-relay.json`
- `<resolved-openclaw-state>/hooks/transforms/clawdentity-peers.json`
- `<resolved-openclaw-state>/skills/clawdentity-openclaw-relay/SKILL.md`
- env overrides:
  - `OPENCLAW_CONFIG_PATH`, `CLAWDBOT_CONFIG_PATH`
  - `OPENCLAW_STATE_DIR`, `CLAWDBOT_STATE_DIR`
  - `OPENCLAW_HOME` (used when explicit config/state overrides are unset)

### Clawdentity files
- `~/.clawdentity/config.json`
- `~/.clawdentity/agents/<agent-name>/secret.key`
- `~/.clawdentity/agents/<agent-name>/public.key`
- `~/.clawdentity/agents/<agent-name>/identity.json`
- `~/.clawdentity/agents/<agent-name>/registry-auth.json`
- `~/.clawdentity/agents/<agent-name>/ait.jwt`
- `~/.clawdentity/peers.json`
- `~/.clawdentity/openclaw-agent-name`
- `~/.clawdentity/openclaw-relay.json`
- `~/.clawdentity/openclaw-connectors.json`
- `~/.clawdentity/pairing/` (ephemeral QR PNG storage, auto-cleaned after 900s)
- `~/.clawdentity/cache/registry-keys.json` (1-hour TTL, used by `verify`)
- `~/.clawdentity/cache/crl-claims.json` (15-minute TTL, used by `verify`)

## Setup Input Contract

`clawdentity openclaw setup` is self-setup only. It does not accept peer routing fields.

Rules:
- setup must succeed without any peer metadata
- peers config snapshot still exists and may be empty until pairing is completed
- setup is expected to bring connector runtime to a websocket-connected state (unless explicitly disabled by advanced flags)

## Peer Map Schema

`~/.clawdentity/peers.json` must be valid JSON:

```json
{
  "peers": {
    "beta": {
      "did": "did:claw:agent:01H...",
      "proxyUrl": "https://beta-proxy.example.com/hooks/agent",
      "agentName": "beta",
      "humanName": "Ira"
    }
  }
}
```

Rules:
- peer alias key uses `[a-zA-Z0-9._-]`
- `did` required and must begin with `did:`
- `proxyUrl` required and must be a valid absolute URL
- `agentName` optional
- `humanName` optional

## Proxy Pairing Prerequisite

Relay delivery policy is trust-pair based on proxy side. Pairing must be completed before first cross-agent delivery.

Current pairing contract is ticket-based with CLI support:

1. Initiator owner starts pairing:
   - CLI: `clawdentity pair start <agent-name> --qr`
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

2. Responder confirms pairing:
   - CLI: `clawdentity pair confirm <agent-name> --qr-file <path>`
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
- `openclawHookToken` is optional in schema but should be present after `clawdentity openclaw setup`; connector runtime uses it for `/hooks/*` auth when no explicit hook token option/env is provided.
- `updatedAt` is ISO-8601 UTC timestamp.
- Proxy runtime precedence is: `OPENCLAW_BASE_URL` env first, then `openclaw-relay.json`, then built-in default.

## Connector Handoff Contract

The transform does not send directly to the peer proxy. It posts to the local connector runtime:
- Endpoint candidates are loaded from OpenClaw-local `hooks/transforms/clawdentity-relay.json` (generated by `openclaw setup`) and attempted in order.
- Default fallback endpoint remains `http://127.0.0.1:19400/v1/outbound`.
- Runtime may also use:
  - `CLAWDENTITY_CONNECTOR_BASE_URL`
  - `CLAWDENTITY_CONNECTOR_OUTBOUND_PATH`
- `openclaw setup <agentName>` is the primary self-setup path and should leave runtime healthy.
- `connector start <agentName>` is advanced/manual recovery; it resolves bind URL from `~/.clawdentity/openclaw-connectors.json` when explicit env override is absent.

Outbound JSON body sent by transform:

```json
{
  "peer": "beta",
  "peerDid": "did:claw:agent:01H...",
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

### Metadata expectation

Registry metadata (`/v1/metadata`) should return a valid `proxyUrl`.

Known defaults:

| Registry URL | Metadata proxy URL |
|-------------|--------------------|
| `https://registry.clawdentity.com` | `https://proxy.clawdentity.com` |
| `https://dev.registry.clawdentity.com` | `https://dev.proxy.clawdentity.com` |

Recovery: rerun onboarding (`clawdentity invite redeem <clw_inv_...> --display-name <human-name>`) so local config aligns to registry metadata.

## Pairing Error Codes

### `pair start` errors

| HTTP Status | Error Code | Meaning |
|-------------|-----------|---------|
| 403 | `PROXY_PAIR_OWNERSHIP_FORBIDDEN` | Initiator ownership check failed |
| 503 | `PROXY_PAIR_OWNERSHIP_UNAVAILABLE` | Registry ownership lookup unavailable |
| — | `CLI_PAIR_AGENT_NOT_FOUND` | Agent ait.jwt or secret.key missing/empty |
| — | `CLI_PAIR_HUMAN_NAME_MISSING` | Local config is missing `humanName`; set via invite redeem or config |
| — | `CLI_PAIR_PROXY_URL_REQUIRED` | Proxy URL could not be resolved |
| — | `CLI_PAIR_START_INVALID_TTL` | ttlSeconds must be a positive integer |
| — | `CLI_PAIR_INVALID_PROXY_URL` | Proxy URL is invalid |
| — | `CLI_PAIR_REQUEST_FAILED` | Unable to connect to proxy URL |

### `pair confirm` errors

| HTTP Status | Error Code | Meaning |
|-------------|-----------|---------|
| 404 | `PROXY_PAIR_TICKET_NOT_FOUND` | Pairing ticket is invalid or expired |
| 410 | `PROXY_PAIR_TICKET_EXPIRED` | Pairing ticket has expired |
| — | `CLI_PAIR_CONFIRM_TICKET_REQUIRED` | Either --ticket or --qr-file is required |
| — | `CLI_PAIR_CONFIRM_INPUT_CONFLICT` | Cannot provide both --ticket and --qr-file |
| — | `CLI_PAIR_CONFIRM_TICKET_INVALID` | Pairing ticket is invalid |
| — | `CLI_PAIR_CONFIRM_QR_FILE_NOT_FOUND` | QR file not found |
| — | `CLI_PAIR_CONFIRM_QR_NOT_FOUND` | No pairing QR code found in image |

## Cache Files

| Path | TTL | Used By |
|------|-----|---------|
| `~/.clawdentity/cache/registry-keys.json` | 1 hour | `verify` command — cached registry signing public keys |
| `~/.clawdentity/cache/crl-claims.json` | 15 minutes | `verify` command — cached certificate revocation list |

Cache is populated on first `verify` call and refreshed when TTL expires. Stale cache is used as fallback when registry is unreachable.

## Peer Alias Derivation

When `pair confirm` saves a new peer, alias is derived automatically:

1. Parse peer DID to extract ULID component.
2. Take last 8 characters of ULID, lowercase: `peer-<last8>`.
3. If alias already exists in `peers.json` for a different DID, append numeric suffix: `peer-<last8>-2`, `peer-<last8>-3`, etc.
4. If peer DID already exists in `peers.json`, reuse existing alias (no duplicate entry).
5. Fallback alias is `peer` if DID is not a valid agent DID.

Alias validation: `[a-zA-Z0-9._-]`, max 128 characters.
