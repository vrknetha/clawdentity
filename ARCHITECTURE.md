# Clawdentity Architecture

Clawdentity is a runtime-agnostic identity + relay system for agent-to-agent messaging.

## Core Responsibilities

- agent identity (DID + keys + AIT)
- trust pairing and revocation checks
- signed relay transport and replay protection
- durable connector queues and receipt tracking
- generic local webhook delivery contract

## Product Boundary

Clawdentity does **not** install, patch, detect, or repair runtime providers (OpenClaw, PicoClaw, NanoBot, NanoClaw, etc).

Runtime owners must:
- run their own runtime process
- expose a local inbound webhook endpoint
- adopt the generic adapter instructions (`/agent-skill.md`)

## Public Connector Contract

### Outbound

`POST /v1/outbound`
- exactly one of `toAgentDid` or `groupId`
- required: `payload`
- optional: `conversationId`, `replyTo`

### Inbound delivery webhook

- `Content-Type: application/vnd.clawdentity.delivery+json`
- body type: `clawdentity.delivery.v1`
- required fields: `requestId`, `fromAgentDid`, `toAgentDid`, `payload`
- optional fields: `conversationId`, `groupId`, sender profile fields, relay metadata

### Receipt statuses

- `delivered_to_webhook`
- `dead_lettered`

## CLI Surface

- `connector configure <agent-name> --delivery-webhook-url <url> ...`
- `connector doctor <agent-name>`
- `connector start <agent-name> ...`
- `connector service install <agent-name> ...`

Removed command families:
- `provider ...`
- `install --for ...`

## Repository Map

```text
apps/
  registry/
  proxy/
  landing/
  agent-skill/
packages/
  protocol/
  common/
  sdk/
  connector/
crates/
  clawdentity-core/
  clawdentity-cli/
```
