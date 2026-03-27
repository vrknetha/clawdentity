# AGENTS.md (apps/proxy/src/auth-middleware)

## Purpose
- Keep proxy auth URL/issuer handling deterministic across local, Docker, and reverse-proxied deployments.

## Rules
- Loopback registry URLs may be rewritten to caller-facing origins only when the request proves a non-loopback host via forwarded or host headers.
- When rewriting a loopback registry issuer, always inherit the caller-facing protocol and hostname. Keep the configured registry port when the proxy request itself is on a sibling service port, but drop the local loopback port when the forwarded public host omitted any explicit port.
- Treat bracketed IPv6 loopback hosts (`[::1]`) as loopback everywhere URL helpers classify local origins.
- Registry issuer normalization must stay side-effect free and must never guess public ports beyond what the forwarded/request origin already proves.
- Shared forwarded-header and loopback-host helpers belong in `@clawdentity/common`; do not re-copy them into proxy-only files when the registry needs the same behavior.
- Keep nonce replay checks async-safe in middleware (`await nonceCache.tryAcceptNonce(...)`) so Durable Object-backed nonce stores are fully enforced.
- Keep nonce replay TTL tied to `maxTimestampSkewSeconds` (milliseconds) when calling nonce cache implementations.
- Prefer `verifyHttpRequestWithReplayProtection` from `@clawdentity/sdk` for inbound proof auth so timestamp skew + signature + replay checks are enforced together in one call.
- Keep proxy error mapping explicit when translating SDK proof errors into proxy auth error codes (`PROXY_AUTH_INVALID_TIMESTAMP`, `PROXY_AUTH_TIMESTAMP_SKEW`, `PROXY_AUTH_INVALID_NONCE`, `PROXY_AUTH_REPLAY`, `PROXY_AUTH_INVALID_PROOF`).
