# AGENTS.md (packages/connector/src/runtime)

## Purpose
- Keep runtime orchestration readable by separating auth, transport, relay, replay, and server responsibilities.

## Rules
- Keep delivery webhook mechanics in `deliveryWebhook.ts`; avoid contract duplication elsewhere.
- Keep hook token sync precedence centralized in `deliveryWebhook-hook-token.ts`.
- Keep probe in-flight/health transitions in `deliveryWebhook-probe.ts`.
- Keep replay orchestration and receipt callbacks in `replay.ts`.
- Keep durable receipt retry/dequeue mechanics in `receipt-outbox.ts`.
- Keep runtime startup/shutdown responsible for outbox lifecycle and resource cleanup.
- Reuse shared payload builders in `../deliveryWebhook-payload.ts`.
- Do not add runtime-specific naming or delivery logic.
- Keep dead-letter admin endpoints (`/v1/inbound/dead-letter*`) loopback-only unless explicit auth is introduced.
