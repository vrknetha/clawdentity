# AGENTS.md (packages/connector/src/client)

## Purpose
- Keep the public connector client API stable and runtime-agnostic.

## Rules
- Keep delivery/retry behavior in `delivery.ts` and inbound ack orchestration in `inbound-delivery.ts`.
- Keep websocket lifecycle and reconnect behavior centralized in client helpers.
- Keep outbound xor routing (`toAgentDid` vs `groupId`) consistent with Rust runtime contract.
- Do not add provider/platform-specific payload branches.
