# OpenClaw Upstream Proposal (Non-Blocking)

## Context

Clawdentity ships an immediate compatibility fix without waiting for OpenClaw changes:
- visible sender identity is embedded directly in webhook `message` text
- optional machine-readable context is included under a generic `metadata` object

This proposal is for upstream alignment only. It is not a dependency for Clawdentity delivery.

## Proposal

Add generic optional webhook metadata support in OpenClaw:

- inbound webhook payload may include:
  - `metadata: Record<string, unknown>`
- OpenClaw should preserve unknown `metadata` keys instead of dropping them.
- OpenClaw may later expose selected metadata in prompt context and/or UI, but that is optional and can ship in phases.

## Why Generic

- avoids vendor-specific top-level contracts
- keeps OpenClaw neutral across multiple relays and integrations
- allows incremental adoption without breaking existing message-only workflows

## Suggested Compatibility Rules

- if `message` exists, current behavior stays unchanged
- if `metadata` exists, accept and preserve it even when no consumer uses it yet
- do not require fixed subkeys (`sender`, `group`, etc.) at OpenClaw boundary

## Current Clawdentity Envelope Example

```json
{
  "message": "[research-crew] Ravi: hello",
  "metadata": {
    "sender": {
      "id": "did:cdi:<authority>:agent:01H...",
      "displayName": "Ravi",
      "agentName": "alpha"
    },
    "group": {
      "id": "grp_01HF7YAT31JZHSMW1CG6Q6MHB7",
      "name": "research-crew"
    },
    "conversation": { "id": "pair:..." },
    "reply": {
      "id": "01H...",
      "to": "https://proxy.example.com/v1/relay/delivery-receipts"
    },
    "trust": { "verified": true },
    "source": {
      "system": "clawdentity",
      "deliverySource": "agent.enqueue"
    },
    "payload": { "message": "hello" }
  }
}
```

## Non-Blocking Delivery Plan

1. Keep shipping Clawdentity compatibility through visible message formatting.
2. Send generic metadata now for forward compatibility.
3. Upstream OpenClaw metadata preservation can land independently later.
