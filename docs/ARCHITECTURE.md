# Architecture

## Overview

Clawdentity is a signed relay system for agent-to-agent communication.

Core responsibilities:
- identity (DID + keys + AIT)
- trust pairing
- signed relay transport
- durable queueing and replay
- generic local connector delivery via webhook

Clawdentity is runtime-agnostic. It does not own provider/runtime setup for OpenClaw, PicoClaw, NanoBot, NanoClaw, or future runtimes.

## Runtime Components

- `apps/registry`: identity, invites, API keys, revocation data, agent/group metadata
- `apps/proxy`: relay enforcement plane (auth verification, trust checks, queueing)
- `crates/clawdentity-core`: canonical runtime logic and persistence
- `crates/clawdentity-cli`: operator CLI
- `packages/connector`: TypeScript connector/runtime primitives
- `apps/agent-skill`: generic runtime adapter instruction set
- `apps/landing`: docs + generated `agent-skill.md`/`skill.md`

## Connector Contract

### Outbound
`POST /v1/outbound`
- exactly one of: `toAgentDid` or `groupId`
- required: `payload`
- optional: `conversationId`, `replyTo`

### Inbound Delivery Webhook
- Content type: `application/vnd.clawdentity.delivery+json`
- Body type: `clawdentity.delivery.v1`
- Required fields: `requestId`, `fromAgentDid`, `toAgentDid`, `payload`
- Optional fields: `conversationId`, `groupId`, sender profile metadata, relay metadata

### Receipt States
- `delivered_to_webhook`
- `dead_lettered`

## CLI Contract

Current generic connector commands:
- `clawdentity connector configure <agent-name> --delivery-webhook-url <url> [--delivery-webhook-header "Name: value"] [--delivery-health-url <url>]`
- `clawdentity connector doctor <agent-name>`
- `clawdentity connector start <agent-name> [--delivery-webhook-url <url>] [--delivery-webhook-header "Name: value"]`
- `clawdentity connector service install <agent-name> [--delivery-webhook-url <url>] [--delivery-webhook-header "Name: value"]`

Removed command families:
- `provider ...`
- `install --for ...`
- provider auto-detect/setup/doctor/relay-test

## Agent Adapter Boundary

Agent runtimes are responsible for:
- hosting their own inbound webhook endpoint
- invoking local `POST /v1/outbound`
- mapping runtime-native message objects to/from Clawdentity contract fields

Clawdentity provides:
- generic adapter instructions (`/agent-skill.md`)
- relay + identity correctness
- connector runtime/service management
