# AGENTS.md (crates/clawdentity-core/src/providers/openclaw)

## Purpose
- Define guardrails for Rust-owned OpenClaw install, setup, doctor, and relay-test behavior.

## Rules
- `assets.rs` is the single place that projects bundled OpenClaw skill files into local OpenClaw state.
- OpenClaw skill asset installs may rewrite the canonical site origin only from explicit local/operator overrides (`CLAWDENTITY_SITE_BASE_URL` in process env or the profile `.env`); never bake non-production URLs into the published asset bundle.
- Keep provider setup OpenClaw-first: require a readable `openclaw.json`, preserve existing OpenClaw auth, then persist Clawdentity relay metadata.
- Keep OpenClaw target validation strict: provider setup/runtime metadata must treat `openclawBaseUrl` as the OpenClaw gateway only, never the Clawdentity registry or proxy.
- Inbound peer delivery for OpenClaw must target the visible main-session ingress (`/hooks/wake`) by default; `/hooks/agent` creates isolated hook sessions and hides relay traffic from normal chat UX.
- Wake-style inbound payloads must carry the rendered relay copy in both `text` and top-level `message`; OpenClaw may accept the hook without surfacing it when `message` is omitted.
- Wake-style inbound payloads must only include `sessionId` when the inbound relay payload explicitly provides one; never hardcode `"main"` because operators may use a different default session.
- The custom `send-to-peer` hook mapping must stay on OpenClaw `wake` action semantics; `agent` mappings no longer guarantee that side-effect transforms relay anything before local hook completion.
- Provider setup must surface readiness honestly: if relay metadata was saved but the connector hop is still dead, return an action-required setup status instead of reporting success.
- Provider setup must propagate explicit `connector_base_url` and `relay_transform_peers_path` overrides unchanged into every persisted artifact; do not recompute host lists or fallback file paths from partial inputs.
- Explicit non-loopback connector URLs are operator-owned runtimes; setup may verify but must not pretend they are ready when the probe still fails.
- Keep doctor and relay-test compatible with container-mounted OpenClaw homes and explicit env overrides.
- Keep `provider doctor --for openclaw` read-only and CLI-free: diagnostics that only inspect local state or HTTP endpoints must not require the `openclaw` binary on PATH.
- Explicit CLI home/state roots must beat ambient `OPENCLAW_*` env vars; isolated-home runs are a release gate.
- When an explicit home already looks like an OpenClaw profile root (`openclaw.json`, `hooks/`, `skills/`), write directly into that root instead of inventing an extra `.openclaw/` layer.
- Never rewrite `gateway.auth` from Clawdentity. OpenClaw owns token/password/trusted-proxy/SecretRef auth decisions.
- Keep runtime files under the repo structural limits: move test-only fixtures into sibling `*_tests.rs` or `test_support.rs` modules instead of leaving large `#[cfg(test)]` blocks inline.
- Public OpenClaw helper functions need `///` docs, and runtime helpers that start repeating config writes or branch-heavy auth logic should be split before they cross the 50-line rule.
- Use `openclaw onboard`, `openclaw doctor --fix`, and `openclaw dashboard` in remediation text when OpenClaw itself is broken.
- Keep detection and setup helpers `clippy -D warnings` clean; prefer flattened `if let ... && ...` control flow over nested single-branch checks.
- URL collision guards must compare OpenClaw, proxy, and registry service origins, not full URLs with paths, so `/hooks/wake` suffixes cannot bypass misconfiguration checks.
- Do not reintroduce JS CLI bundle dependencies.
