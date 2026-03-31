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

## Projected Relay Peer Snapshot

The default OpenClaw relay path reads the projected peer snapshot referenced by `hooks/transforms/clawdentity-relay.json`. In the standard setup that file is `hooks/transforms/clawdentity-peers.json`.

```json
{
  "peers": {
    "beta": {
      "did": "did:cdi:<authority>:agent:01H...",
      "proxyUrl": "https://beta-proxy.example.com/hooks/agent",
      "agentName": "beta",
      "displayName": "Ira",
      "framework": "openclaw",
      "description": "Research assistant",
      "lastSyncedAtMs": 1710000000000
    }
  }
}
```

Rules:
- peer alias key uses `[a-zA-Z0-9._-]`
- `did` required and must be a valid DID v2 agent identifier (`did:cdi:<authority>:agent:<ulid>`)
- `proxyUrl` required and must be a valid absolute URL
- `agentName` and `displayName` are optional additive metadata
- `framework`, `description`, and `lastSyncedAtMs` are optional additive metadata written by the Rust peer refresh/sync path
- current transform code only requires `did` and `proxyUrl` for direct routing; additive metadata may be ignored by older readers without breaking delivery

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
- Confirm auto-persists peer DID/proxy mapping locally, and the runtime may then project a `clawdentity-peers.json` snapshot for OpenClaw-local relay use.
- Same-agent sender/recipient is allowed by policy without explicit pair entry.

## Relay Input Contract

The OpenClaw transform reads `ctx.payload`.

The `send-to-peer` OpenClaw hook mapping is a `wake` mapping, not an `agent` mapping.
That keeps the request payload stable enough for the relay transform to read the raw `peer`
and `message` fields before local handling is skipped.

- If `payload.peer` is absent:
  - return payload unchanged
  - do not relay
- If `payload.peer` exists:
  - resolve peer from the projected peer snapshot (`clawdentity-peers.json` by default)
  - only `did` and `proxyUrl` are required for direct routing
  - derive a default relay `conversationId` only from stable DIDs: projected `localAgentDid` + peer DID
  - if `payload.conversationId` is a non-empty string, treat it as an explicit relay-lane override
  - remove `peer` from forwarded body
  - send JSON POST to local connector outbound endpoint
  - return `null` to skip local handling
- If `payload.groupId` exists:
  - validate it as `grp_<ULID>`
  - forward it as top-level `groupId` to the local connector outbound endpoint
  - do not auto-derive a group `conversationId`
  - remove routing-only fields from the forwarded application payload
- Do not send `peer` and `group`/`groupId` together in one payload.

Routing exclusivity rule:
- direct routing uses `payload.peer`
- group routing uses `payload.groupId`
- do not send both in one outbound request

## Relay Runtime Metadata Contract

`hooks/transforms/clawdentity-relay.json` is projected by `clawdentity provider setup --for openclaw --agent-name <agent-name>`.

Required fields for relay lane derivation:

```json
{
  "connectorBaseUrl": "http://127.0.0.1:19400",
  "connectorBaseUrls": ["http://127.0.0.1:19400"],
  "connectorPath": "/v1/outbound",
  "localAgentDid": "did:cdi:<authority>:agent:01H...",
  "peersConfigPath": "/path/to/clawdentity-peers.json"
}
```

Rules:
- `localAgentDid` is the primary source of truth for default relay `conversationId` derivation.
- Transform must read projected `localAgentDid` from `clawdentity-relay.json`; production/runtime behavior must not depend on host-local Clawdentity state.
- Production/container runtime behavior must not depend on probing host `HOME`.
- Missing or invalid `localAgentDid` is a setup/runtime error. Re-run `clawdentity provider setup --for openclaw --agent-name <agent-name>`.

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
- `openclawBaseUrl` must point at the OpenClaw gateway itself. Do not reuse the Clawdentity registry URL or proxy URL here.
- `openclawHookToken` is optional in schema but should be present after `clawdentity provider setup --for openclaw --agent-name <agent-name>`; connector runtime uses it for `/hooks/*` auth when no explicit hook token option/env is provided.
- `updatedAt` is ISO-8601 UTC timestamp.
- Proxy runtime precedence is: `OPENCLAW_BASE_URL` env first, then `openclaw-relay.json`, then built-in default.

## Connector Handoff Contract

The transform does not send directly to the peer proxy. It posts to the local connector runtime:
- Endpoint candidates are loaded from OpenClaw-local `hooks/transforms/clawdentity-relay.json` (generated by provider setup for OpenClaw) and attempted in order.
- The same runtime file must also provide `localAgentDid` for default relay lane derivation.
- Default fallback endpoint remains `http://127.0.0.1:19400/v1/outbound`.
- Runtime may also use:
  - `CLAWDENTITY_CONNECTOR_BASE_URL`
  - `CLAWDENTITY_CONNECTOR_OUTBOUND_PATH`
- `provider setup --for openclaw --agent-name <agent-name>` is the primary self-setup path after OpenClaw itself is healthy.
- `connector start <agent-name>` is advanced/manual recovery; it resolves bind URL from `~/.clawdentity/openclaw-connectors.json` when explicit env override is absent.

Outbound JSON body sent by transform for direct routing:

```json
{
  "toAgentDid": "did:cdi:<authority>:agent:01H...",
  "conversationId": "<explicit-or-derived-relay-lane>",
  "payload": {
    "event": "agent.message"
  }
}
```

Outbound JSON body sent by transform for group routing:

```json
{
  "groupId": "grp_<ULID>",
  "conversationId": "<optional-explicit-group-lane>",
  "payload": {
    "event": "agent.message"
  }
}
```

Rules:
- `payload.peer`, `payload.group`, and `payload.groupId` are removed before creating the forwarded `payload` object.
- direct routing uses `toAgentDid`
- group routing uses `groupId`
- do not send both direct and group routing in one outbound request
- Transform sends relay `conversationId` as a top-level connector field, not as hidden ordering metadata inside the forwarded payload body.
- Default relay `conversationId` is deterministic per local-agent/peer-agent pair so one peer relationship stays on one replay lane by default.
- Default relay `conversationId` must be derived from sorted `localAgentDid` + peer DID so alias renames do not change replay lanes.
- `payload.conversationId` may override the default relay lane when the caller intentionally wants a different lane.
- Group routing never invents a default `conversationId`; callers must pass one explicitly when they want a stable group thread.
- `conversationId` may still remain inside the application payload if the caller included it there.
- Transform sends `Content-Type: application/json` only.
- Connector runtime is responsible for Clawdentity auth headers and request signing when calling peer proxy.

## OpenClaw Inbound Metadata Contract

For `/hooks/wake`, the connector delivers a rendered text envelope:

```json
{
  "message": "Message in research-crew from alpha (Ravi)\n\nhello\n\nRequest ID: 01H...\nConversation ID: pair:...\nReply To: https://proxy.example.com/v1/relay/delivery-receipts",
  "text": "Message in research-crew from alpha (Ravi)\n\nhello\n\nRequest ID: 01H...\nConversation ID: pair:...\nReply To: https://proxy.example.com/v1/relay/delivery-receipts",
  "mode": "now"
}
```

Rules:
- `/hooks/wake` is text-first and optimized for immediate OpenClaw wake handling.
- `sessionId` is copied through when the original payload carried it.
- Machine-readable sender/group metadata for the wake path is carried by headers, not by a nested JSON metadata object.

After proxy verification and connector shaping, the canonical OpenClaw-facing delivery payload is:

```json
{
  "message": "hello",
  "senderDid": "did:cdi:<authority>:agent:<ulid>",
  "senderAgentName": "alpha",
  "senderDisplayName": "Ravi",
  "recipientDid": "did:cdi:<authority>:agent:<ulid>",
  "groupId": "grp_<ULID>",
  "groupName": "research-crew",
  "isGroupMessage": true,
  "requestId": "01H...",
  "metadata": {
    "conversationId": "pair:...",
    "replyTo": "https://proxy.example.com/v1/relay/delivery-receipts",
    "payload": {}
  }
}
```

Contract guarantees:
- `senderDid`, `recipientDid`, and `groupId` (when group-scoped) are canonical identity fields.
- `senderAgentName`, `senderDisplayName`, and `groupName` are expected runtime metadata in healthy systems.
- Sender/group friendly fields are resolved from trusted local + registry state; sender-supplied payload names are not authoritative.
- If friendly lookup fails, delivery must still succeed with canonical IDs, and missing friendly fields should remain `null` instead of synthetic ID-as-name fallbacks.
- `/hooks/wake` summary text should prefer friendly sender/group names when available, with ID fallback for readability only.

Canonical OpenClaw-facing headers:
- `x-clawdentity-agent-did`
- `x-clawdentity-to-agent-did`
- `x-clawdentity-verified`
- `x-request-id`
- `x-clawdentity-agent-name` when known
- `x-clawdentity-display-name` when known
- `x-clawdentity-group-id` when present

Note:
- proxy relay routing still uses `x-claw-group-id`
- the `x-clawdentity-*` headers above are the post-verification inbound metadata contract for local OpenClaw delivery
- `/hooks/agent` includes structured `groupId`, `groupName`, and `isGroupMessage`; `/hooks/wake` does not.

## Error Conditions

Relay fails when:
- projected relay runtime metadata is missing `localAgentDid`
- projected relay runtime metadata has invalid `localAgentDid`
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

By default, the proxy forwards the original relay payload unchanged and sends identity separately through structured metadata:

- `x-clawdentity-agent-did`
- `x-clawdentity-to-agent-did`
- `x-clawdentity-verified`
- connector/runtime sender fields such as `fromAgentDid`

When identity injection is explicitly enabled (proxy env `INJECT_IDENTITY_INTO_MESSAGE=true`), the proxy prepends an identity block to the `message` field of relayed payloads for legacy consumers.

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

The connector `deliver` frame includes `fromAgentDid` as a top-level field. Inbound inbox items (`ConnectorInboundInboxItem`) also expose `fromAgentDid` for programmatic sender identification without parsing the identity block. Header-based metadata remains the canonical identity transport; body parsing is legacy-only compatibility mode.

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
- `provider setup --for openclaw` also projects `localAgentDid` into `clawdentity-relay.json` so the transform can derive a stable relay lane inside the container without mounting host `~/.clawdentity`.
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
