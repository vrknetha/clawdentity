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
- Keep `skill/SKILL.md` command utilization section explicit and executable with current CLI commands used by this skill (`config`, `agent`, `openclaw setup/doctor/relay test`, `connector start`, optional `connector service install`).
- Keep pairing prerequisite documented as API-based (`/pair/start`, `/pair/confirm`) until a dedicated CLI pairing command exists.
- When `src/transforms/relay-to-peer.ts` relay envelope, endpoint defaults, or failure mapping changes, update:
  - `skill/SKILL.md`
  - `skill/references/clawdentity-protocol.md`
  - bundled copies in `apps/cli/skill-bundle/openclaw-skill/skill/*`

## Validation Commands
- `pnpm -F @clawdentity/openclaw-skill typecheck`
- `pnpm -F @clawdentity/openclaw-skill test`
- `pnpm -F @clawdentity/openclaw-skill build`

## Skill Runtime Behavior
- Keep onboarding prompts input-focused (invite/API key/URLs) and let the skill decide command execution.
- The agent should run required npm/CLI/filesystem operations via tools and only ask the human for missing inputs.
- Report deterministic completion outputs: local DID, peer alias, and generated filesystem paths.
