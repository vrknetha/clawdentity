# AGENTS.md (apps/openclaw-skill)

## Purpose
- Define conventions for the OpenClaw skill package that relays selected payloads to remote Clawdentity peers.
- Keep peer routing config and local connector handoff deterministic and testable.
- Keep peer profile metadata explicit and non-ambiguous (`agentName`, `humanName`).

## Filesystem Contracts
- Peer routing map lives at `~/.clawdentity/peers.json` by default.
- In profile-mounted/containerized runs, skill behavior must support profile-local Clawdentity state at `<openclaw-state>/.clawdentity` when `~/.clawdentity` is absent.
- When profile-local state is detected, command execution must use `HOME=<openclaw-state>` so CLI resolves a single consistent state root.
- Default onboarding (`clawdentity install --for openclaw` + `clawdentity provider setup --for openclaw`) must project peer + relay runtime snapshots into OpenClaw-local transform directory so containerized gateways can read relay state without mounting `~/.clawdentity`:
  - `<openclaw-state>/hooks/transforms/clawdentity-peers.json`
  - `<openclaw-state>/hooks/transforms/clawdentity-relay.json`
- Local relay handoff uses connector endpoint candidates plus projected `localAgentDid` from `clawdentity-relay.json` and must work across macOS/Linux Docker hosts.
- Relay setup should preserve local OpenClaw upstream URL in `~/.clawdentity/openclaw-relay.json` for proxy runtime fallback.
- Relay setup must also persist `openclawHookToken` in `~/.clawdentity/openclaw-relay.json` so connector runtime can authenticate OpenClaw `/hooks/*` delivery without manual token flags.
- Relay setup must persist per-agent connector bind assignment in `~/.clawdentity/openclaw-connectors.json`.
- Never commit local runtime files (`peers.json`, `secret.key`, `ait.jwt`) to the repository.

## Transform Rules
- `src/transforms/peers-config.ts` is the only module that reads/writes peers config.
- Validate all peers config reads/writes with schema parsing before use.
- `src/transforms/relay-to-peer.ts` must:
  - expose default export accepting OpenClaw transform context (`ctx.payload`)
  - read routing inputs from `payload.peer` (direct) or `payload.group` / `payload.groupId` (group)
  - resolve peer metadata from peers config to preserve alias semantics
  - derive a deterministic default relay `conversationId` only from stable DIDs (`localAgentDid` + peer DID)
  - allow explicit top-level `payload.conversationId` to override that default relay lane
  - send outbound payload to local connector endpoint as JSON
  - send top-level `conversationId` and optional `groupId` in the connector relay envelope
  - remove routing-only fields (`peer`, `group`, `groupId`) from forwarded application payload and wrap the rest in the connector relay envelope
  - return `null` after successful relay so local handling is skipped
- The transform must treat projected `hooks/transforms/clawdentity-relay.json` as the source of truth for `localAgentDid`; do not default back to host `HOME` probing in containerized/runtime code.
- Missing projected `localAgentDid` is a setup/runtime error; do not invent fallback relay lanes from alias names or other mutable local labels.
- If `payload.peer` is absent, return payload unchanged.
- If both direct and group routing inputs are present in one payload, fail fast with a validation error.
- Keep transform thin: route resolution + local connector forward only; do not add registry reads or fan-out logic in transform code.
- Keep setup flow CLI-driven via `clawdentity install --for openclaw` + `clawdentity provider setup --for openclaw`; do not add `configure-hooks.sh`.
- Keep setup flow OpenClaw-first: OpenClaw owns OpenClaw auth and base config, while Clawdentity only installs relay assets, hook mapping, and local runtime metadata.
- If OpenClaw is missing or broken, recovery must point to `openclaw onboard`, `openclaw doctor --fix`, or `openclaw dashboard` before suggesting Clawdentity setup again.
- Keep setup/doctor expectations aligned with connector durable inbox semantics: connector can acknowledge persisted inbound relay messages before local OpenClaw hook delivery, with replay status exposed via `/v1/status` and doctor checks.
- Keep `connector start` documented as advanced/manual recovery only; never require it in the default onboarding flow.
- Keep setup/doctor path resolution compatible with OpenClaw runtime env overrides:
  - `OPENCLAW_CONFIG_PATH`
  - `OPENCLAW_STATE_DIR`
  - `OPENCLAW_HOME` when explicit config/state overrides are unset

## Maintainability
- Keep filesystem path logic centralized; avoid hardcoding `~/.clawdentity` paths across multiple files.
- Keep relay behavior pure except for explicit dependencies (`fetch`, filesystem) so tests stay deterministic.
- Keep relay lane behavior deterministic and documented; do not move ordering semantics into ad-hoc payload parsing, mutable alias names, or per-peer mutable state unless the contract is explicitly revised.
- Prefer schema-first runtime validation over ad-hoc guards.
- Keep skill docs aligned with connector architecture: do not document direct transform-to-peer-proxy signing.
- Keep user-facing onboarding prompt-first, with `/skill.md` as canonical instruction source.
- Keep `skill/SKILL.md` command utilization section explicit and executable with current CLI commands used by this skill (`config`, `invite redeem`, `agent`, `install --for`, `pair`, `verify`, `provider {status|setup|doctor|relay-test}`, advanced `connector start`/`connector service install`).
- Keep pairing flow documented as proxy API-based (`POST /pair/start`, `POST /pair/confirm`, `POST /pair/status`), not unsupported CLI `pair` commands.
- Keep pairing metadata documented and preserved end-to-end: pair APIs exchange `initiatorProfile`/`responderProfile` and peer map stores `agentName` + `humanName`.
- Keep pairing flow deterministic in docs:
  - Initiator default is `POST /pair/start` (returns `clwpair1_...` ticket and optional QR payload).
  - Responder confirms with `POST /pair/confirm`.
  - If confirmation is asynchronous, recover with `POST /pair/status` using the ticket.
- Keep relay-result docs aligned with proxy behavior: `202 state=queued` is an expected async delivery state (not a pairing failure), with retry handled by proxy queue policy.
- Keep identity transport docs aligned with proxy behavior: structured headers and connector metadata are canonical by default, while `INJECT_IDENTITY_INTO_MESSAGE=true` is legacy compatibility only.
- When `src/transforms/relay-to-peer.ts` relay envelope, endpoint defaults, or failure mapping changes, update:
  - `skill/SKILL.md`
  - `skill/references/clawdentity-protocol.md`
  - sync Rust release assets via `pnpm -F @clawdentity/openclaw-skill build && pnpm -F @clawdentity/openclaw-skill run sync:rust-assets`

## Validation Commands
- `pnpm -F @clawdentity/openclaw-skill typecheck`
- `pnpm -F @clawdentity/openclaw-skill test`
- `pnpm -F @clawdentity/openclaw-skill build`

## Skill Runtime Behavior
- Keep onboarding prompts input-focused (registry onboarding code/API key/agent name) and let the skill decide command execution.
- Enforce hosted starter-pass-first wording for the public path: ask for `clw_stp_...` when the user came from `clawdentity.com`, and accept `clw_inv_...` for operator or self-hosted onboarding.
- Enforce onboarding with human identity capture: use `clawdentity invite redeem <clw_stp_...|clw_inv_...> --display-name <human-name>`.
- Allow raw API-key path only when the user explicitly says neither starter pass nor invite is available.
- Never state that API key must be provided before onboarding; `invite redeem` is the default API-key issuance path for both starter passes and invites.
- For first-time onboarding, prefer registry onboarding-code redeem (`clw_stp_...` or `clw_inv_...`) before asking for API key.
- Require a CLI behavior guard before setup execution:
  - `clawdentity provider setup --help` must not show peer-routing or invite-code flags.
  - If such flags appear, upgrade Rust CLI before proceeding (installer scripts or pinned release asset).
- Disambiguate onboarding code types in prompts:
  - `clw_stp_...` = hosted GitHub starter pass (yields PAT via `invite redeem`, limited to one agent)
  - `clw_inv_...` = operator-created registry onboarding invite (yields PAT via `invite redeem`)
  - `clwpair1_...` = proxy trust pairing ticket (used by `/pair/start` / `/pair/confirm`)
- Avoid endpoint drift suggestions in onboarding prompts: do not suggest registry/proxy host changes unless user explicitly asks.
- Keep endpoint defaults production-first (`registry.clawdentity.com`, `proxy.clawdentity.com`); local Docker/development must be handled via env overrides (`CLAWDENTITY_REGISTRY_URL`, `CLAWDENTITY_PROXY_URL`, `CLAWDENTITY_PROXY_WS_URL`).
- If env overrides are present, do not treat config-file URL mismatch as a blocker.
- Keep Rust toolchain guidance in user docs as advanced fallback only; recommended install path is hosted installer scripts.
- Relay setup must be self-setup only via `provider setup --for openclaw --agent-name <agentName>`; peer mappings are created automatically by proxy pairing confirmation (`POST /pair/confirm`).
- Setup success is self-readiness only: do not require peer configuration before reporting onboarding complete.
- The agent should run required npm/CLI/filesystem operations via tools and only ask the human for missing inputs.
- Report deterministic completion outputs: local DID, pairing ticket/QR path, saved peer alias, and generated filesystem paths.

## Dual Container Test State
- For local user-flow validation against two OpenClaw gateways, use:
  - `clawdbot-agent-alpha-1` (host port `18789`)
  - `clawdbot-agent-beta-1` (host port `19001`)
- Keep a reusable pre-skill snapshot where model is already configured:
  - `~/.openclaw-baselines/alpha-kimi-preskill`
  - `~/.openclaw-baselines/beta-kimi-preskill`
- Keep a reusable paired-and-approved snapshot for fast UI + skill onboarding regression:
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
- Use this snapshot as the starting point for every skill onboarding regression run.
- Pairing troubleshooting:
  - If UI shows `Disconnected (1008): pairing required`, OpenClaw device approval is pending.
  - `clawdentity provider doctor --for openclaw` surfaces this as `state.gatewayDevicePairing`.
  - First-line recovery is `openclaw dashboard` so the operator can review the pending device approval in OpenClaw itself.
  - This is not Clawdentity proxy trust pairing (`/pair/start` + `/pair/confirm`); it is only OpenClaw UI/device approval.
  - If device/auth state is broken, use `openclaw doctor --fix` before re-running Clawdentity setup.
