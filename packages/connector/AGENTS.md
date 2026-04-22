# AGENTS.md (packages/connector)

## Purpose
- Provide a runtime-agnostic connector client for WebSocket relay integration and local delivery webhook forwarding.

## Design Rules
- Keep frame contracts in `src/frames.ts` as the single schema authority.
- Keep outbound routing xor semantics (`toAgentDid` vs `groupId`) consistent with Rust runtime.
- Keep reconnect and heartbeat behavior deterministic and testable.
- Keep delivery webhook forwarding centralized; do not spread delivery logic across modules.
- Keep inbound delivery durable: ack relay only after local inbox persistence.
- Keep replay retry/backoff bounded and configurable.
- Keep auth refresh + header regeneration explicit on reconnect.
- Do not add runtime-specific delivery branches or public naming.
