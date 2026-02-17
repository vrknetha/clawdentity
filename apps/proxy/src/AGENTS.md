# AGENTS.md (apps/proxy/src)

## Source Layout
- Keep `index.ts` as runtime bootstrap surface and version export.
- Keep runtime env parsing and defaults in `config.ts`; do not scatter `process.env` reads across handlers.
- Keep agent DID rate-limit env parsing in `config.ts` (`AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE`, `AGENT_RATE_LIMIT_WINDOW_MS`) and validate as positive integers.
- Keep HTTP app composition in `server.ts`.
- Keep Cloudflare Worker fetch startup in `worker.ts`.
- Keep Node runtime startup in `node-server.ts`; use `bin.ts` as Node process entrypoint.
- Keep inbound auth verification in `auth-middleware.ts` with focused helpers for token parsing, registry material loading, CRL checks, and replay protection.
- Keep per-agent DID throttling in `agent-rate-limit-middleware.ts`; do not blend rate-limit state or counters into `auth-middleware.ts`.
- Keep pre-auth public-route IP throttling in `public-rate-limit-middleware.ts`; do not blend unauthenticated probe controls into `auth-middleware.ts`.
- Keep `.env` fallback loading and OpenClaw config (`hooks.token`) fallback logic inside `config.ts` so runtime behavior is deterministic.
- Keep OpenClaw base URL fallback logic in `config.ts`: `OPENCLAW_BASE_URL` env -> `~/.clawdentity/openclaw-relay.json` -> default.
- Keep OpenClaw compatibility vars optional for relay-mode runtime; never require `OPENCLAW_BASE_URL` or hook token for cloud relay startup.
- Keep fallback semantics consistent across merge + parse stages: empty/whitespace env values are treated as missing, so non-empty `.env`/file values can be used.
- Do not derive runtime environment from `NODE_ENV`; use validated `ENVIRONMENT` from proxy config.

## Config Error Handling
- Convert parse failures to `ProxyConfigError` with code `CONFIG_VALIDATION_FAILED`.
- Keep error details field-focused (`fieldErrors` / `formErrors`) and avoid exposing secrets.

## Maintainability
- Prefer schema-driven parsing with small pure helpers for coercion/overrides.
- Keep CRL defaults centralized as exported constants in `config.ts`; do not duplicate timing literals across modules.
- Keep allowlist schema strict and agent-first: reject unknown allowlist keys and require explicit `allowList.agents` membership after verification.
- Keep `ALLOW_ALL_VERIFIED` removed; fail fast when deprecated bypass flags are provided.
- Keep server middleware composable and single-responsibility to reduce churn in later T27-T31 auth/forwarding work.
- Keep `/hooks/agent` forwarding logic isolated in `agent-hook-route.ts`; `server.ts` should only compose middleware/routes.
- Keep relay websocket connect handling isolated in `relay-connect-route.ts`; `server.ts` should only compose middleware/routes.
- Keep DO runtime behavior in `agent-relay-session.ts` (websocket accept, heartbeat alarm, connector delivery RPC).
- Do not import Node-only startup helpers into `worker.ts`; Worker runtime must stay free of process/port startup concerns.
- Keep auth failure semantics stable: auth-invalid requests map to `401`; verified-but-not-allowlisted requests map to `403`; registry keyset outages map to `503`; CRL outages map to `503` when stale behavior is `fail-closed`.
- Keep `/hooks/agent` runtime auth contract strict: require `x-claw-agent-access` and map missing/invalid access credentials to `401`.
- Keep `/hooks/agent` recipient routing explicit: require `x-claw-recipient-agent-did` and resolve DO IDs from that recipient DID, never from owner DID env.
- Keep `/v1/relay/connect` keyed by authenticated connector DID from auth middleware, and reject non-websocket requests with clear client errors.
- Keep pre-auth IP throttling enabled for `/hooks/agent` and `/v1/relay/connect` so repeated unauthenticated probes fail with `429` before auth/registry work.
- Keep rate-limit failure semantics stable: verified requests over budget map to `429` with code `PROXY_RATE_LIMIT_EXCEEDED` and structured warn log event `proxy.rate_limit.exceeded`.
- Keep pre-auth rate-limit failure semantics stable: repeated public-route probes map to `429` with code `PROXY_PUBLIC_RATE_LIMIT_EXCEEDED` and structured warn log event `proxy.public_rate_limit.exceeded`.
- Keep `X-Claw-Timestamp` parsing strict: accept digit-only unix-seconds strings and reject mixed/decimal formats.
- Keep AIT verification resilient to routine key rotation: retry once with a forced keyset refresh on `UNKNOWN_AIT_KID` before rejecting.
- Keep CRL verification resilient to routine key rotation: retry once with a forced keyset refresh on `UNKNOWN_CRL_KID` before dependency-failure mapping.
- Keep `/hooks/agent` input contract strict: require `Content-Type: application/json` and reject malformed JSON with explicit client errors.
- Keep agent-access validation centralized in `auth-middleware.ts` and call registry `POST /v1/agents/auth/validate`; treat non-`204` non-`401` responses as dependency failures (`503`).
- Keep relay delivery failure mapping explicit for `/hooks/agent`: DO delivery/RPC failures -> `502`, unavailable DO namespace -> `503`.
- Keep identity message injection explicit and default-on (`INJECT_IDENTITY_INTO_MESSAGE=true`); operators can disable it when unchanged forwarding is required.
- Keep identity augmentation logic in small pure helpers (`sanitizeIdentityField`, `buildIdentityBlock`, payload mutation helper) inside `agent-hook-route.ts`; avoid spreading identity-format logic into `server.ts`.
- When identity injection is enabled, sanitize identity fields (strip control chars, normalize whitespace, enforce max lengths) and mutate only string `message` fields.
