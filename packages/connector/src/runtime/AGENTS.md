# AGENTS.md (packages/connector/src/runtime)

## Purpose
- Keep connector runtime orchestration readable by separating auth, transport, relay, and server concerns.

## Rules
- Keep runtime auth refresh/sync orchestration in `auth-lifecycle.ts`; treat `auth-storage.ts` as persistence/shape helpers only.
- Keep auth disk sync/persistence in `auth-storage.ts`; avoid ad-hoc credential writes.
- Keep OpenClaw hook-token sync precedence in `openclaw-hook-token.ts` so explicit token overrides remain centralized.
- Keep hook-delivery retry and abort behavior in `openclaw.ts`.
- Keep gateway probe in-flight/health transitions in `openclaw-probe.ts`; avoid duplicate probe loops in `runtime.ts`.
- Keep replay/probe policy loading and retry-delay calculations in `policy.ts`.
- Keep replay orchestration and receipt callbacks in `replay.ts`; avoid re-embedding lane scheduling and dead-letter transitions in `runtime.ts`.
- Keep relay peers snapshot parsing centralized in `relay-transform-peers.ts`; reuse it for sender-profile enrichment.
- Replay should resolve sender profile headers once per replay batch from relay peers snapshot and omit profile headers when peer metadata is unavailable.
- Keep outbound relay and receipt callbacks in `relay-service.ts`; callback routing authority is always the runtime-owned proxy receipt endpoint (`defaultReceiptCallbackUrl`), not inbound `replyTo`.
- Keep durable receipt retry/dequeue mechanics in `receipt-outbox.ts` and wire its lifecycle in `runtime.ts`; preserve at-least-once semantics with idempotent keys (`requestId:status`).
- Treat `receipt-outbox.ts` as a single-writer command actor: every `enqueue`/`flushDue` mutation must flow through one serialized lock so concurrent callers cannot interleave file reads/writes.
- Keep receipt-outbox tests deterministic: use fake timers for retry backoff assertions and avoid wall-clock `setTimeout` dependency.
- Runtime startup/shutdown must include receipt-outbox lifecycle hooks (`flushDue` on start and periodic retry loop teardown on stop) so queued receipts survive transient proxy outages.
- Runtime stop must deterministically dispose inbound inbox resources (`inboundInbox.close()`) after server shutdown so SQLite handles do not leak across restart cycles.
- Keep HTTP route handling in `server.ts` and avoid embedding route logic in helpers.
- Keep URL/header/parse helpers focused in `url.ts`, `ws.ts`, and `parse.ts`.
- Keep OpenClaw receipt payload shaping in `openclaw.ts` so `/hooks/agent` (`message`) and `/hooks/wake` (`text`) compatibility stays centralized.
