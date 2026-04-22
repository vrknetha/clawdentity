# Design Decisions

## Agent-Agnostic Connector Contract

Date: 2026-04-21

Decision:
- Keep a single generic relay + connector contract that any runtime can implement.
- Publish the generic adapter skill as the agent-facing integration guide.

Why:
- The stable value of Clawdentity is signed relay + identity correctness, not runtime ownership.
- A single local webhook contract keeps agent integration simple and testable.

Current connector surface:
- `connector configure|doctor|start|service install`
- send API: `POST /v1/outbound`
- inbound webhook: `POST /hooks/message`
- receipt statuses: `delivered_to_webhook` and `dead_lettered`
- adapter instructions: `apps/agent-skill`, published as `/agent-skill.md`

Boundary:
- runtimes own their adapter/webhook endpoint behavior
- Clawdentity owns protocol correctness, relay correctness, and connector durability

Tradeoff:
- runtime operators need to implement the webhook endpoint described by the skill
- Clawdentity keeps one stable contract instead of runtime-specific branches
