# AGENTS.md (apps/openclaw-skill/src)

## Source Layout
- Keep package exports in `index.ts` only.
- Keep peer config helpers in `transforms/peers-config.ts`.
- Keep local agent auth state helpers in `transforms/registry-auth.ts`.
- Keep network relay behavior in `transforms/relay-to-peer.ts`.

## Safety Rules
- Validate external input (`payload`, peer config JSON) before use.
- Reuse `@clawdentity/common` guards (for example `isRecord`) instead of redefining local record/type guard helpers in transform modules.
- Peer DID validation must be DID v2 only: accept `did:cdi:<authority>:<agent|human>:<ulid>` via protocol parsers (`parseDid` / `parseAgentDid`) and never use raw prefix checks.
- Do not log relay payload contents or local connector credential material.
- Keep local auth/lock timestamps UTC and standardized via SDK datetime helpers (`nowUtcMs`, `toIso`, `nowIso`) instead of direct `Date` calls.
- Keep transform relay path as local connector handoff only, not direct peer HTTP calls.
- Relay transform must prefer OpenClaw-local runtime artifacts in `hooks/transforms/`:
  - `clawdentity-relay.json` for connector endpoint candidates/path and projected `localAgentDid`
  - `clawdentity-peers.json` for peer alias map snapshot visible inside containerized OpenClaw runtimes
- `peersConfigPath` from relay runtime config may be absolute or transform-relative; honor explicit absolute overrides exactly.
- Assume default onboarding requires a healthy OpenClaw base first; `clawdentity install --for openclaw` and `clawdentity provider setup --for openclaw` layer relay assets on top but do not take over OpenClaw auth or imply runtime startup.
- Connector endpoint fallback order must remain container-safe for macOS/Linux hosts, but any explicit connector base URL from setup/runtime config must stay first and exact.
- Keep peer alias semantics deterministic: validate `payload.peer` against peers config before connector handoff.
- Keep relay lane semantics deterministic: default `conversationId` must be derived only from stable DIDs (`localAgentDid` + peer DID), with explicit top-level `payload.conversationId` allowed only as an override.
- Keep relay ordering metadata at the connector envelope level: send top-level `conversationId` to `/v1/outbound` instead of relying on application-payload fields for replay lane grouping.
- Treat missing or invalid projected `localAgentDid` as a setup/runtime error; do not synthesize relay lanes from alias names or host-home fallbacks.
- Keep connector failure mapping deterministic (`404` endpoint unavailable, `409` peer alias conflict, network failure generic outage).
- Assume connector runtime OpenClaw auth is sourced from `~/.clawdentity/openclaw-relay.json` (`openclawHookToken`) when explicit token flags/env are absent.
- Keep peer schema strict (`did`, `proxyUrl`, optional `agentName`, optional `humanName`) and reject malformed values early.

## Testing Rules
- Use temp directories for filesystem tests; no dependency on real user home state.
- Mock `fetch` in relay tests and assert local connector endpoint + request body contract.
- Assert relay request bodies include the top-level `conversationId` contract and cover derived-default, explicit-override, and missing-runtime-metadata failure cases.
- Cover both happy path and failure paths (missing peer mapping, invalid peers config, connector rejection).
- Include deterministic connector failure tests (endpoint missing, network unavailable).
