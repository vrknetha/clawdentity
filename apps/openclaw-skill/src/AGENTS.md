# AGENTS.md (apps/openclaw-skill/src)

## Source Layout
- Keep package exports in `index.ts` only.
- Keep peer config helpers in `transforms/peers-config.ts`.
- Keep local agent auth state helpers in `transforms/registry-auth.ts`.
- Keep network relay behavior in `transforms/relay-to-peer.ts`.

## Safety Rules
- Validate external input (`payload`, peer config JSON, selected agent name) before use.
- Resolve selected agent in deterministic order: explicit option, env var, `~/.clawdentity/openclaw-agent-name`, then single-agent fallback.
- Do not log or persist secret material from `secret.key` or `ait.jwt`.
- Keep outbound peer requests as JSON POSTs with explicit auth + PoP headers.
- Require outbound relay requests to include `x-claw-agent-access` from local `registry-auth.json`.
- Keep refresh/write operations for `registry-auth.json` lock-protected and atomic.
- On relay `401` auth failures, use shared SDK refresh+retry orchestration and retry exactly once.
- Keep peer schema strict (`did`, `proxyUrl`, optional `name`) and reject malformed values early.

## Testing Rules
- Use temp directories for filesystem tests; no dependency on real user home state.
- Mock `fetch` in relay tests and assert emitted headers/body.
- Cover both happy path and failure paths (missing peer mapping, missing credentials, invalid config).
- Include refresh-retry tests: first relay `401` -> registry refresh -> one retry success.
