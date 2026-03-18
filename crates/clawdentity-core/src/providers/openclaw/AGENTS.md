# AGENTS.md (crates/clawdentity-core/src/providers/openclaw)

## Purpose
- Define guardrails for Rust-owned OpenClaw install, setup, doctor, and relay-test behavior.

## Rules
- `assets.rs` is the single place that projects bundled OpenClaw skill files into local OpenClaw state.
- Keep provider setup OpenClaw-first: require a readable `openclaw.json`, preserve existing OpenClaw auth, then persist Clawdentity relay metadata.
- Provider setup must propagate explicit `connector_base_url` and `relay_transform_peers_path` overrides unchanged into every persisted artifact; do not recompute host lists or fallback file paths from partial inputs.
- Keep doctor and relay-test compatible with container-mounted OpenClaw homes and explicit env overrides.
- Keep `provider doctor --for openclaw` read-only and CLI-free: diagnostics that only inspect local state or HTTP endpoints must not require the `openclaw` binary on PATH.
- Explicit CLI home/state roots must beat ambient `OPENCLAW_*` env vars; isolated-home runs are a release gate.
- When an explicit home already looks like an OpenClaw profile root (`openclaw.json`, `hooks/`, `skills/`), write directly into that root instead of inventing an extra `.openclaw/` layer.
- Never rewrite `gateway.auth` from Clawdentity. OpenClaw owns token/password/trusted-proxy/SecretRef auth decisions.
- Use `openclaw onboard`, `openclaw doctor --fix`, and `openclaw dashboard` in remediation text when OpenClaw itself is broken.
- Keep detection and setup helpers `clippy -D warnings` clean; prefer flattened `if let ... && ...` control flow over nested single-branch checks.
- Do not reintroduce JS CLI bundle dependencies.
