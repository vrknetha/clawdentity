# AGENTS.md (crates/clawdentity-core/src/db)

## Purpose
- Keep SQLite access helpers predictable, minimal, and reusable across CLI/runtime paths.

## Rules
- Keep peer lookups centralized in `peers.rs`; callers should not hand-roll SQL for alias/DID resolution.
- Any new lookup helper must trim/validate input and return `Ok(None)` for empty identifiers.
- Preserve stable row mapping (`alias`, `did`, `proxy_url`, `agent_name`, `human_name`, timestamps) across list/get helpers so higher layers can reuse the same `PeerRecord`.
- Inbound retry/dead-letter persistence must preserve delivery provenance fields (for example `delivery_source`) so replay logic can enforce trusted-only side effects.
- Add focused unit tests for every new DB helper (happy path plus empty-input behavior when relevant).
