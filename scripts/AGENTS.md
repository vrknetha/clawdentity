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
