# AGENTS.md (apps/openclaw-skill)

## Purpose
- Define conventions for the OpenClaw skill package that relays selected payloads to remote Clawdentity peers.
- Keep peer routing config and local connector handoff deterministic and testable.
- Keep peer profile metadata explicit and non-ambiguous (`agentName`, `humanName`).

## Filesystem Contracts
- Peer routing map lives at `~/.clawdentity/peers.json` by default.
- In profile-mounted/containerized runs, skill behavior must support profile-local Clawdentity state at `<openclaw-state>/.clawdentity` when `~/.clawdentity` is absent.
- When profile-local state is detected, command execution must use `HOME=<openclaw-state>` so CLI resolves a single consistent state root.
- `openclaw setup` must project peer + relay runtime snapshots into OpenClaw-local transform directory so containerized gateways can read relay state without mounting `~/.clawdentity`:
  - `<openclaw-state>/hooks/transforms/clawdentity-peers.json`
  - `<openclaw-state>/hooks/transforms/clawdentity-relay.json`
- Local relay handoff uses connector endpoint candidates from `clawdentity-relay.json` and must work across macOS/Linux Docker hosts.
- Relay setup should preserve local OpenClaw upstream URL in `~/.clawdentity/openclaw-relay.json` for proxy runtime fallback.
- Relay setup must also persist `openclawHookToken` in `~/.clawdentity/openclaw-relay.json` so connector runtime can authenticate OpenClaw `/hooks/*` delivery without manual token flags.
- Relay setup must persist per-agent connector bind assignment in `~/.clawdentity/openclaw-connectors.json`.
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
- Keep setup flow fully automated via CLI: `openclaw setup` provisions/retains `hooks.token`, stabilizes OpenClaw `gateway.auth` token mode for deterministic UI/device auth, starts connector runtime, auto-recovers pending gateway device approvals when possible, verifies websocket readiness, and fails fast only when unrecoverable drift remains.
- Keep setup/doctor expectations aligned with connector durable inbox semantics: connector can acknowledge persisted inbound relay messages before local OpenClaw hook delivery, with replay status exposed via `/v1/status` and doctor checks.
- Keep `connector start` documented as advanced/manual recovery only; never require it in the default onboarding flow.
- Keep setup/doctor path resolution compatible with OpenClaw runtime env overrides:
  - `OPENCLAW_CONFIG_PATH` and legacy `CLAWDBOT_CONFIG_PATH`
  - `OPENCLAW_STATE_DIR` and legacy `CLAWDBOT_STATE_DIR`
  - `OPENCLAW_HOME` when explicit config/state overrides are unset

## Maintainability
- Keep filesystem path logic centralized; avoid hardcoding `~/.clawdentity` paths across multiple files.
- Keep relay behavior pure except for explicit dependencies (`fetch`, filesystem) so tests stay deterministic.
- Prefer schema-first runtime validation over ad-hoc guards.
- Keep skill docs aligned with connector architecture: do not document direct transform-to-peer-proxy signing.
- Keep `skill/SKILL.md` command utilization section explicit and executable with current CLI commands used by this skill (`config`, `invite redeem`, `agent`, `openclaw setup/doctor/relay test`, `pair`, advanced `connector start`/`connector service install`).
- Keep pairing flow documented as CLI-based (`clawdentity pair start`, `clawdentity pair confirm`), not raw proxy HTTP calls.
- Keep pairing metadata documented and preserved end-to-end: pair APIs exchange `initiatorProfile`/`responderProfile` and peer map stores `agentName` + `humanName`.
- Keep pairing flow deterministic in docs:
  - Initiator default is `clawdentity pair start <agent-name> --qr --wait`.
  - Responder confirms with `pair confirm`.
  - If initiator ran without `--wait`, recover with `pair status --ticket <clwpair1_...> --wait`.
- Keep relay-result docs aligned with proxy behavior: `202 state=queued` is an expected async delivery state (not a pairing failure), with retry handled by proxy queue policy.
- When `src/transforms/relay-to-peer.ts` relay envelope, endpoint defaults, or failure mapping changes, update:
  - `skill/SKILL.md`
  - `skill/references/clawdentity-protocol.md`
  - regenerate CLI bundle via `pnpm -F @clawdentity/openclaw-skill build && pnpm -F clawdentity run sync:skill-bundle`

## Validation Commands
- `pnpm -F @clawdentity/openclaw-skill typecheck`
- `pnpm -F @clawdentity/openclaw-skill test`
- `pnpm -F @clawdentity/openclaw-skill build`

## Skill Runtime Behavior
- Keep onboarding prompts input-focused (registry invite/API key/agent name) and let the skill decide command execution.
- Enforce invite-first onboarding: ask for `clw_inv_...` by default and redeem invite before any API-key fallback.
- Enforce invite-first onboarding with human identity capture: use `clawdentity invite redeem <clw_inv_...> --display-name <human-name>`.
- Allow raw API-key path only when user explicitly says invite is unavailable.
- Never state that API key must be provided before onboarding; invite redeem is the default API-key issuance path.
- For first-time onboarding, prefer registry invite redeem (`clw_inv_...`) before asking for API key.
- Require a CLI behavior guard before setup execution:
  - `clawdentity openclaw setup --help` must not show peer-routing flags and must not show `--invite-code`.
  - If `--invite-code` appears, upgrade CLI (`npm install -g clawdentity@latest`) before proceeding.
- Disambiguate invite types in prompts:
  - `clw_inv_...` = registry onboarding invite (yields PAT via `invite redeem`)
  - `clwpair1_...` = proxy trust pairing ticket (used by `pair start` / `pair confirm`)
- Avoid endpoint drift suggestions in onboarding prompts: do not suggest registry/proxy host changes unless user explicitly asks.
- Keep endpoint defaults production-first (`registry.clawdentity.com`, `proxy.clawdentity.com`); local Docker/development must be handled via env overrides (`CLAWDENTITY_REGISTRY_URL`, `CLAWDENTITY_PROXY_URL`, `CLAWDENTITY_PROXY_WS_URL`).
- If env overrides are present, do not treat config-file URL mismatch as a blocker.
- Relay setup must be self-setup only via `openclaw setup <agentName>`; peer mappings are created automatically by QR pairing (`pair confirm`).
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
  - `openclaw doctor` surfaces this as `state.gatewayDevicePairing`.
  - First-line recovery is always `clawdentity openclaw setup <agent-name>` (auto-approval path).
  - This is not Clawdentity proxy trust pairing (`/pair/start` + `/pair/confirm`); it is only OpenClaw UI/device approval.
  - Manual device approval commands are operator fallback only when setup reports the local `openclaw` command is unavailable.
