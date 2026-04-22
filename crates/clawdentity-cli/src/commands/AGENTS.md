# AGENTS.md (crates/clawdentity-cli/src/commands)

## Purpose
- Keep the Rust CLI as the single supported operator surface.
- Keep connector/runtime flows agent-agnostic.

## Rules
- Keep the CLI centered on identity, trust, and connector operations.
- Keep connector command layout stable:
  - `connector configure <agent-name> --delivery-webhook-url <url> [--delivery-webhook-header "Name: value"] [--delivery-health-url <url>]`
  - `connector doctor <agent-name>`
  - `connector start <agent-name> [--delivery-webhook-url <url>] [--delivery-webhook-header "Name: value"] [--delivery-health-url <url>]`
  - `connector service install <agent-name> [--delivery-webhook-url <url>] [--delivery-webhook-header "Name: value"]`
- Keep `--platform auto|launchd|systemd` scoped only to service manager selection.
- Keep command JSON output stable and machine-readable.
- Any command that mixes blocking filesystem or blocking HTTP with async runtime must isolate blocking work using `spawn_blocking`.
- Keep structural line-budget rules green; split large helpers or add justified `#[allow(clippy::too_many_lines)]` on orchestrators only.
