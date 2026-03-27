# AGENTS.md (crates/clawdentity-cli/src/commands/connector)

## Purpose
- Keep connector runtime helpers split by concern so structural rules stay green.

## Rules
- Put inbound relay delivery, retry persistence, and OpenClaw hook payload shaping in focused helper modules instead of growing `connector.rs`.
- If inbound delivery is persisted for local retry, ACK the relay as accepted so the retry path stays single-source.
- Wake payloads must only include `sessionId` when the inbound payload explicitly carries one.
- `/hooks/wake` remains the visible default for peer delivery; `/hooks/agent` is only for explicit isolated-hook routing.
- Keep hook payload builders split into focused helpers so the structural 50-line non-test function rule stays green.
