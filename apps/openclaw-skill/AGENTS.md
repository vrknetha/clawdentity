# AGENTS.md (apps/openclaw-skill)

## Purpose
- Define conventions for the OpenClaw skill package that relays selected payloads to remote Clawdentity peers.
- Keep peer routing config, credential loading, and PoP signing deterministic and testable.

## Filesystem Contracts
- Peer routing map lives at `~/.clawdentity/peers.json` by default.
- Local agent credentials are read from `~/.clawdentity/agents/<agent-name>/secret.key` and `~/.clawdentity/agents/<agent-name>/ait.jwt`.
- Agent selection order for relay runtime:
  - explicit transform override (`agentName`)
  - environment (`CLAWDENTITY_AGENT_NAME`)
  - `~/.clawdentity/openclaw-agent-name`
  - single local agent auto-detection
- Never commit local runtime files (`peers.json`, `secret.key`, `ait.jwt`) to the repository.

## Transform Rules
- `src/transforms/peers-config.ts` is the only module that reads/writes peers config.
- Validate all peers config reads/writes with schema parsing before use.
- `src/transforms/relay-to-peer.ts` must:
  - expose default export accepting OpenClaw transform context (`ctx.payload`)
  - read `payload.peer`
  - resolve peer proxy URL from peers config
  - sign outbound POST with `signHttpRequest`
  - send `Authorization: Claw <AIT>` and `X-Claw-*` PoP headers
  - remove `peer` from forwarded JSON payload
  - return `null` after successful relay so local handling is skipped
- If `payload.peer` is absent, return payload unchanged.
- Keep setup flow CLI-driven via `clawdentity openclaw setup`; do not add `configure-hooks.sh`.

## Maintainability
- Keep filesystem path logic centralized; avoid hardcoding `~/.clawdentity` paths across multiple files.
- Keep relay behavior pure except for explicit dependencies (`fetch`, clock, random bytes, filesystem) so tests stay deterministic.
- Prefer schema-first runtime validation over ad-hoc guards.

## Validation Commands
- `pnpm -F @clawdentity/openclaw-skill typecheck`
- `pnpm -F @clawdentity/openclaw-skill test`
- `pnpm -F @clawdentity/openclaw-skill build`

## Docker E2E Workflow
- Run E2E with two OpenClaw containers: Alpha (sender) and Beta (receiver), each with isolated HOME storage.
- Install and execute onboarding through skill flow only (`npm install clawdentity --skill` plus agent-executed skill steps).
- Human role in E2E is limited to supplying invite code and confirmations requested by the agent.
- Do not edit relay hooks, peer config, or selected-agent files manually during validation.
- After skill setup, verify these artifacts exist and are agent-generated: `~/.clawdentity/peers.json`, `~/.clawdentity/openclaw-agent-name`, `~/.openclaw/hooks/transforms/relay-to-peer.mjs`.
- For reruns after failures, clear skill-generated artifacts first; only perform full identity reset (`~/.clawdentity/agents/<agent-name>/`) when identity reprovisioning is needed.
