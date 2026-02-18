# AGENTS.md (apps/openclaw-skill)

## Purpose
- Define conventions for the OpenClaw skill package that relays selected payloads to remote Clawdentity peers.
- Keep peer routing config and local connector handoff deterministic and testable.

## Filesystem Contracts
- Peer routing map lives at `~/.clawdentity/peers.json` by default.
- Local relay handoff targets connector runtime endpoint `http://127.0.0.1:19400/v1/outbound` by default (override via connector env/options when needed).
- Relay setup should preserve local OpenClaw upstream URL in `~/.clawdentity/openclaw-relay.json` for proxy runtime fallback.
- Never commit local runtime files (`peers.json`, `secret.key`, `ait.jwt`) to the repository.

## Transform Rules
- `src/transforms/peers-config.ts` is the only module that reads/writes peers config.
- Validate all peers config reads/writes with schema parsing before use.
- `src/transforms/relay-to-peer.ts` must:
  - expose default export accepting OpenClaw transform context (`ctx.payload`)
  - read `payload.peer`
  - resolve peer metadata from peers config to preserve alias semantics
  - send outbound payload to local connector endpoint as JSON
  - remove `peer` from forwarded application payload and wrap it in connector relay envelope
  - return `null` after successful relay so local handling is skipped
- If `payload.peer` is absent, return payload unchanged.
- Keep setup flow CLI-driven via `clawdentity openclaw setup`; do not add `configure-hooks.sh`.

## Maintainability
- Keep filesystem path logic centralized; avoid hardcoding `~/.clawdentity` paths across multiple files.
- Keep relay behavior pure except for explicit dependencies (`fetch`, filesystem) so tests stay deterministic.
- Prefer schema-first runtime validation over ad-hoc guards.
- Keep skill docs aligned with connector architecture: do not document direct transform-to-peer-proxy signing.
- Keep `skill/SKILL.md` command utilization section explicit and executable with current CLI commands used by this skill (`config`, `invite redeem`, `agent`, `openclaw setup/doctor/relay test`, `pair`, `connector start`, optional `connector service install`).
- Keep pairing flow documented as CLI-based (`clawdentity pair start`, `clawdentity pair confirm`), not raw proxy HTTP calls.
- When `src/transforms/relay-to-peer.ts` relay envelope, endpoint defaults, or failure mapping changes, update:
  - `skill/SKILL.md`
  - `skill/references/clawdentity-protocol.md`
  - regenerate CLI bundle via `pnpm -F @clawdentity/openclaw-skill build && pnpm -F clawdentity run sync:skill-bundle`

## Validation Commands
- `pnpm -F @clawdentity/openclaw-skill typecheck`
- `pnpm -F @clawdentity/openclaw-skill test`
- `pnpm -F @clawdentity/openclaw-skill build`

## Skill Runtime Behavior
- Keep onboarding prompts input-focused (invite/API key/URLs) and let the skill decide command execution.
- For first-time onboarding, prefer registry invite redeem (`clw_inv_...`) before asking for API key.
- Disambiguate invite types in prompts:
  - `clw_inv_...` = registry onboarding invite (yields PAT via `invite redeem`)
  - `clawd1_...` = peer relay invite (used by `openclaw setup`)
  - `clwpair1_...` = proxy trust pairing ticket (used by `pair start` / `pair confirm`)
- The agent should run required npm/CLI/filesystem operations via tools and only ask the human for missing inputs.
- Report deterministic completion outputs: local DID, peer alias, and generated filesystem paths.

## Dual Container Test State
- For local user-flow validation against two OpenClaw gateways, use:
  - `clawdbot-agent-alpha-1` (host port `18789`)
  - `clawdbot-agent-beta-1` (host port `19001`)
- Keep a reusable pre-skill snapshot where model is already configured:
  - `~/.openclaw-baselines/alpha-kimi-preskill`
  - `~/.openclaw-baselines/beta-kimi-preskill`
- Keep a reusable paired-and-approved snapshot for fast UI + skill install regression:
  - `~/.openclaw-baselines/alpha-kimi-preskill-device-approved-20260217-194756`
  - `~/.openclaw-baselines/beta-kimi-preskill-device-approved-20260217-194756`
  - stable aliases:
    - `~/.openclaw-baselines/alpha-kimi-preskill-device-approved-latest`
    - `~/.openclaw-baselines/beta-kimi-preskill-device-approved-latest`
- Keep a reusable paired-stable snapshot for repeat tests without re-approving UI devices:
  - `~/.openclaw-baselines/alpha-kimi-paired-stable-20260217-200909`
  - `~/.openclaw-baselines/beta-kimi-paired-stable-20260217-200909`
  - stable aliases:
    - `~/.openclaw-baselines/alpha-kimi-paired-stable-latest`
    - `~/.openclaw-baselines/beta-kimi-paired-stable-latest`
- Snapshot must represent:
  - `openclaw.json` default model set to `kimi-coding/k2p5`
  - no relay skill artifacts installed yet
- Use this snapshot as the starting point for every skill install regression run.
- Pairing troubleshooting:
  - If UI shows `Disconnected (1008): pairing required`, OpenClaw device approval is pending.
  - This is not Clawdentity proxy trust pairing (`/pair/start` + `/pair/confirm`); it is only OpenClaw UI/device approval.
  - Run:
    - `docker exec clawdbot-agent-alpha-1 sh -lc 'node openclaw.mjs devices list --json'`
    - `docker exec clawdbot-agent-beta-1 sh -lc 'node openclaw.mjs devices list --json'`
  - Approve any pending request IDs:
    - `docker exec clawdbot-agent-alpha-1 sh -lc 'node openclaw.mjs devices approve <requestId>'`
    - `docker exec clawdbot-agent-beta-1 sh -lc 'node openclaw.mjs devices approve <requestId>'`
