# AGENTS.md (scripts/openclaw-local-profile)

## Purpose
- Keep the local dual-Docker OpenClaw policy fixtures explicit, minimal, and limited to the trusted local harness.

## Rules
- `openclaw.json` and `exec-approvals.json` here are test harness fixtures, not production defaults.
- Keep these fixtures scoped to the dual local Docker flow driven by `scripts/openclaw-relay-docker-ready.sh`.
- Keep Control UI device auth enabled here; do not set `gateway.controlUi.dangerouslyDisableDeviceAuth` in this fixture because it downgrades browser sessions into scope-less operator connects on latest OpenClaw.
- `gateway.controlUi.allowInsecureAuth` is acceptable here only as localhost HTTP compatibility for the Docker harness, not as a general deployment default.
- `tools.exec` may stay `security=full` and `ask=off` here because the harness is a trusted local operator environment.
- `tools.elevated` may be enabled only for internal `webchat` here, and wildcard access is acceptable only because this fixture is local-harness-only.
- Keep `tools.web.fetch.enabled=true` in this fixture so harness-managed profiles always expose `web_fetch` unless a script explicitly overrides it.
- If `agents.defaults.elevatedDefault` is set here, it must be justified by removing local approval loops in Docker WebChat; do not copy that default into public docs or general user profiles.
- The fixture itself should stay auth-format-agnostic; Codex subscription reuse belongs in the reset harness by copying host `~/.codex/auth.json` into each Docker profile and exporting `CODEX_HOME=/home/node/.openclaw/.codex`, not by embedding OAuth material in this fixture.
- Local Docker profiles should default to `openai-codex/gpt-5.4` with `openrouter/moonshotai/kimi-k2.5` fallback; keep host Codex auth wiring available so the primary path stays deterministic.
- Keep private-network allowances limited to local test hosts (`host.docker.internal`, `localhost`, `127.0.0.1`) unless the harness requirements change.
- Private-network browser allowances here do not change `web_fetch` private-host blocking; for prompt-first skill fetches, use a public HTTPS URL (for example via `PUBLIC_SITE_BASE_URL`) and fail fast when it is not reachable.
