# AGENTS.md (apps/openclaw-skill/src)

## Source Layout
- Keep package exports in `index.ts` only.
- Keep peer config helpers in `transforms/peers-config.ts`.
- Keep local agent auth state helpers in `transforms/registry-auth.ts`.
- Keep network relay behavior in `transforms/relay-to-peer.ts`.

## Safety Rules
- Validate external input (`payload`, peer config JSON) before use.
- Do not log relay payload contents or local connector credential material.
- Keep transform relay path as local connector handoff only (`http://127.0.0.1:19400/v1/outbound` by default), not direct peer HTTP calls.
- Keep peer alias semantics deterministic: validate `payload.peer` against peers config before connector handoff.
- Keep connector failure mapping deterministic (`404` endpoint unavailable, `409` peer alias conflict, network failure generic outage).
- Keep peer schema strict (`did`, `proxyUrl`, optional `name`) and reject malformed values early.

## Testing Rules
- Use temp directories for filesystem tests; no dependency on real user home state.
- Mock `fetch` in relay tests and assert local connector endpoint + request body contract.
- Cover both happy path and failure paths (missing peer mapping, invalid peers config, connector rejection).
- Include deterministic connector failure tests (endpoint missing, network unavailable).
