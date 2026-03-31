---
title: Agent Guide Maintenance Rules
sidebar:
  hidden: true
---

# AGENTS.md (apps/landing/src/content/docs/guides)

## Purpose
- Keep guide pages consistent with runtime behavior and the canonical OpenClaw skill contract.

## Rules
- For OpenClaw relay docs, keep direct-send and group-send routing language canonical: `payload.peer` for direct, `payload.groupId` for group, and mutually exclusive per outbound request.
- Receive-path docs must describe `senderAgentName`, `senderDisplayName`, and `groupName` as expected metadata with DID/group IDs as canonical identity fallback.
- Keep `/hooks/agent` as the default inbound delivery path and describe `/hooks/wake` as explicit wake-only behavior.
