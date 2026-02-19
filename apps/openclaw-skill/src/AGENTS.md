# AGENTS.md (apps/openclaw-skill/src)

## Source Layout
- Keep package exports in `index.ts` only.
- Keep peer config helpers in `transforms/peers-config.ts`.
- Keep local agent auth state helpers in `transforms/registry-auth.ts`.
- Keep network relay behavior in `transforms/relay-to-peer.ts`.

## Safety Rules
- Validate external input (`payload`, peer config JSON) before use.
- Do not log relay payload contents or local connector credential material.
- Keep transform relay path as local connector handoff only, not direct peer HTTP calls.
- Relay transform must prefer OpenClaw-local runtime artifacts in `hooks/transforms/`:
  - `clawdentity-relay.json` for connector endpoint candidates/path
  - `clawdentity-peers.json` for peer alias map snapshot visible inside containerized OpenClaw runtimes
- Assume default onboarding runs `openclaw setup` end-to-end (including runtime startup); direct `connector start` is manual recovery only.
- Connector endpoint fallback order must remain container-safe for macOS/Linux hosts (for example `host.docker.internal`, `gateway.docker.internal`, linux bridge/default gateway, then loopback).
- Keep peer alias semantics deterministic: validate `payload.peer` against peers config before connector handoff.
- Keep connector failure mapping deterministic (`404` endpoint unavailable, `409` peer alias conflict, network failure generic outage).
- Assume connector runtime OpenClaw auth is sourced from `~/.clawdentity/openclaw-relay.json` (`openclawHookToken`) when explicit token flags/env are absent.
- Keep peer schema strict (`did`, `proxyUrl`, optional `agentName`, optional `humanName`) and reject malformed values early.

## Testing Rules
- Use temp directories for filesystem tests; no dependency on real user home state.
- Mock `fetch` in relay tests and assert local connector endpoint + request body contract.
- Cover both happy path and failure paths (missing peer mapping, invalid peers config, connector rejection).
- Include deterministic connector failure tests (endpoint missing, network unavailable).
