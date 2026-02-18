# Clawdentity Relay Protocol Reference

## Purpose

Define the exact runtime contract used by `relay-to-peer.mjs`.

## Filesystem Paths

### OpenClaw files
- `~/.openclaw/openclaw.json`
- `~/.openclaw/hooks/transforms/relay-to-peer.mjs`
- `~/.openclaw/workspace/skills/clawdentity-openclaw-relay/SKILL.md`

### Clawdentity files
- `~/.clawdentity/config.json`
- `~/.clawdentity/agents/<agent-name>/secret.key`
- `~/.clawdentity/agents/<agent-name>/ait.jwt`
- `~/.clawdentity/peers.json`
- `~/.clawdentity/openclaw-agent-name`
- `~/.clawdentity/openclaw-relay.json`

## Invite Code Contract

Invite codes are prefixed with `clawd1_` and contain base64url JSON:

```json
{
  "v": 1,
  "issuedAt": "2026-02-15T20:00:00.000Z",
  "did": "did:claw:agent:01H...",
  "proxyUrl": "https://beta-proxy.example.com/hooks/agent",
  "alias": "beta",
  "name": "Beta Agent"
}
```

Rules:
- `v` must be `1`.
- `issuedAt` is ISO-8601 UTC timestamp.
- `did` must be an agent DID.
- `proxyUrl` must be absolute `http` or `https`.
- `alias` is optional but preferred for zero-question setup.

## Peer Map Schema

`~/.clawdentity/peers.json` must be valid JSON:

```json
{
  "peers": {
    "beta": {
      "did": "did:claw:agent:01H...",
      "proxyUrl": "https://beta-proxy.example.com/hooks/agent",
      "name": "Beta Agent"
    }
  }
}
```

Rules:
- peer alias key uses `[a-zA-Z0-9._-]`
- `did` required and must begin with `did:`
- `proxyUrl` required and must be a valid absolute URL
- `name` optional

## Proxy Pairing Prerequisite

Relay delivery policy is trust-pair based on proxy side. Pairing must be completed before first cross-agent delivery.

Current pairing contract is ticket-based with CLI support:

1. Initiator owner starts pairing:
   - CLI: `clawdentity pair start <agent-name> --proxy-url <url> --qr`
   - proxy route: `POST /pair/start`
   - headers:
     - `Authorization: Claw <AIT>`
     - `x-claw-owner-pat: <owner-pat>`
   - body (optional):

```json
{
  "ttlSeconds": 300
}
```

2. Responder confirms pairing:
   - CLI: `clawdentity pair confirm <agent-name> --qr-file <path> --proxy-url <url>`
   - proxy route: `POST /pair/confirm`
   - headers:
     - `Authorization: Claw <AIT>`
   - body:

```json
{
  "ticket": "clwpair1_..."
}
```

Rules:
- `ticket` is one-time and expires (default 5 minutes, max 15 minutes).
- Confirm establishes mutual trust for the initiator/responder pair.
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
  "updatedAt": "2026-02-15T20:00:00.000Z"
}
```

Rules:
- `openclawBaseUrl` must be absolute `http` or `https`.
- `updatedAt` is ISO-8601 UTC timestamp.
- Proxy runtime precedence is: `OPENCLAW_BASE_URL` env first, then `openclaw-relay.json`, then built-in default.

## Connector Handoff Contract

The transform does not send directly to the peer proxy. It posts to the local connector runtime:
- Default endpoint: `http://127.0.0.1:19400/v1/outbound`
- Optional overrides:
  - `CLAWDENTITY_CONNECTOR_BASE_URL`
  - `CLAWDENTITY_CONNECTOR_OUTBOUND_PATH`

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
