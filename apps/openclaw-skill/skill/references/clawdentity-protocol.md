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

## Relay Input Contract

The OpenClaw transform reads `ctx.payload`.

- If `payload.peer` is absent:
  - return payload unchanged
  - do not relay
- If `payload.peer` exists:
  - resolve peer from `peers.json`
  - remove `peer` from forwarded body
  - send JSON POST to `peer.proxyUrl`
  - return `null` to skip local handling

## Relay Agent Selection Contract

Relay resolves local agent name in this order:
1. transform option `agentName`
2. `CLAWDENTITY_AGENT_NAME`
3. `~/.clawdentity/openclaw-agent-name`
4. single local agent fallback from `~/.clawdentity/agents/`

## Outbound Auth Contract

Headers sent to peer proxy:
- `Authorization: Claw <AIT>`
- `Content-Type: application/json`
- `X-Claw-Timestamp`
- `X-Claw-Nonce`
- `X-Claw-Body-SHA256`
- `X-Claw-Proof`

Signing inputs:
- HTTP method: `POST`
- path+query from peer URL
- unix seconds timestamp
- random nonce
- outbound JSON body bytes
- agent secret key from `secret.key`

## Error Conditions

Relay fails when:
- no selected local agent can be resolved
- peer alias missing from config
- `secret.key` or `ait.jwt` missing/empty/invalid
- peer returns non-2xx
- peer network request fails

Error messages should include file/path context but never print secret content.
