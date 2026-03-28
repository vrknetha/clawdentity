# AGENTS.md (scripts)

## Purpose
- Keep repository utility scripts deterministic, fast, and CI-safe.
- Centralize reusable quality checks that are invoked from root `package.json` scripts.

## Rules
- Prefer Node-based scripts for cross-platform behavior in local and CI environments.
- Keep script output deterministic: sorted traversal, stable formatting, and explicit non-zero exits on guard failures.
- File-size guard entrypoint is `scripts/quality/check-file-size.mjs`, exposed at root as `pnpm check:file-size`.
- The file-size guard enforces an 800-line limit for tracked source files under `apps/**` and `packages/**`, excluding `dist`, `.wrangler`, `worker-configuration.d.ts`, `drizzle/meta`, and `node_modules`.

- `openclaw-relay-docker-ready.sh` is the canonical clean-room reset harness for the dual OpenClaw Docker E2E flow.
- Keep `openclaw-relay-docker-ready.sh` free of npm/package-manager assumptions; it must work with Rust-owned skill installation only.
- `openclaw-relay-docker-ready.sh` must preserve `CLAWDENTITY_REGISTRY_URL` / `CLAWDENTITY_PROXY_URL` as the canonical environment-level targets; use `DOCKER_REGISTRY_URL` / `DOCKER_PROXY_URL` only for explicit container-side overrides, with `host.docker.internal` as the final fallback.
- `openclaw-relay-docker-ready.sh` must write a site-base override into the OpenClaw profile `.env` so local OpenClaw skill installs can point at a local landing site without forking the published production skill/install assets.
- `openclaw-relay-docker-ready.sh` must resolve one deterministic `CLAWDENTITY_VERSION` per run (manifest latest unless overridden) and mirror that into both profile `.env` files before onboarding.
- `openclaw-relay-docker-ready.sh` must build the local workspace CLI (`cargo build -p clawdentity-cli`) before test runs when `BUILD_CLI_BEFORE_TEST=1`, and fail early if the built binary is missing.
- Keep local Docker OpenClaw policy fixtures in `scripts/openclaw-local-profile/`; the reset script may only inject per-run values like gateway token, UI ports, and local endpoint URLs.
- When the local Docker harness is meant to behave like a signed-in Codex operator, `openclaw-relay-docker-ready.sh` must copy the host `~/.codex/auth.json` into each profile, set `CODEX_HOME=/home/node/.openclaw/.codex`, and point the default model at `openai-codex/gpt-5.4`; do not re-encode those tokens into custom app config.
- Keep host-facing and container-facing site origins separate when needed: `CLAWDENTITY_SITE_BASE_URL` is the host/default origin, and `DOCKER_SITE_BASE_URL` is the container-side override for profiles running inside Docker.
- `env/sync-worktree-env.sh` must not bake `ENVIRONMENT` or environment-specific registry/proxy routing into app-level `.env` files; Wrangler env blocks are the source of truth for `local` vs `dev` runtime identity.
- When preserving profile `.env` files across a reset, keep only secrets and gateway token continuity. Do not carry forward stale `CLAWDENTITY_*` endpoint overrides from previous dev/prod runs into a clean local test reset.
- A clean reset must remove stale Clawdentity workspace state directories (for example `workspace/.clawdentity*`) so agent identity and connector state cannot leak across runs.
- The dual OpenClaw harness must rewrite `gateway.controlUi.allowedOrigins` per exposed host port so alpha/beta Control UI websocket auth works on both `18789` and `19001`.
- The dual OpenClaw harness must keep token auth enabled, but it must not set `gateway.controlUi.dangerouslyDisableDeviceAuth=true`; latest OpenClaw needs real browser device identity on Control UI sessions to retain operator scopes.
- The dual OpenClaw harness may set `gateway.controlUi.allowInsecureAuth=true` for localhost HTTP compatibility, but that is only a local-Docker bridge aid and must not be treated as a production recommendation.
- The dual OpenClaw harness should auto-approve pending `openclaw-control-ui` device requests for a short window immediately after reset; this preserves real device auth while removing the repetitive manual "pairing required" click loop in the local Docker workflow.
- The dual OpenClaw harness must set `agents.defaults.sandbox.mode=off` and `tools.exec.host=gateway` for these local Docker control profiles; otherwise prompt-first onboarding fails closed because exec defaults to sandbox while no sandbox runtime exists in the harness.
- The dual OpenClaw harness may enable `tools.elevated` only for the internal `webchat` provider and set `agents.defaults.elevatedDefault=full` when the local Docker test goal is “no approval loops”; do not broaden this to general user channels or non-harness profiles.
- Keep the harness exec defaults aligned with the trusted local operator use case: `tools.exec.security=full` and `tools.exec.ask=off` so the UI agent can run the installer and CLI onboarding commands directly inside the container without approval deadlocks.
- The dual OpenClaw harness must seed `~/.openclaw/exec-approvals.json` from the local fixture with matching `full/off` defaults for `defaults` and `agents.main`; do not rely on `openclaw.json` alone because host-side exec approvals are enforced from the approvals file.
- The dual OpenClaw harness must treat Codex OAuth as the supported fix for local OpenAI quota drift when the host already has working `~/.codex/auth.json`; keep API-key fallbacks only as preserved env state, not as the primary local model path.
- The dual OpenClaw harness may keep a trusted-network browser SSRF policy in the local OpenClaw fixture, but do not assume that fixes prompt-first `web_fetch` for `host.docker.internal`; production-like onboarding tests should use a public-like HTTPS skill URL when OpenClaw's guarded fetch blocks private-network sources.
- A clean reset must also remove OpenClaw workspace completion markers (`workspace/.openclaw/workspace-state.json`) so prompt-first onboarding starts from a genuinely fresh state.
- The harness must verify local dependency readiness from host and container paths (`registry` health, `proxy` health, landing `/skill.md`) before reporting ready state.
