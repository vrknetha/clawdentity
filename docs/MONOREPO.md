# Monorepo

## Top-level Layout

```text
apps/
  registry/
  proxy/
  landing/
  agent-skill/
packages/
  protocol/
  common/
  sdk/
  connector/
crates/
  clawdentity-core/
  clawdentity-cli/
  tests/
docs/
scripts/
```

## Ownership

- `apps/registry`: registry HTTP API
- `apps/proxy`: relay/proxy runtime
- `apps/landing`: docs site + generated onboarding artifacts
- `apps/agent-skill`: runtime-agnostic adapter instructions
- `packages/protocol`: protocol contracts and shared schema logic
- `packages/connector`: TS connector/client runtime
- `crates/clawdentity-core`: Rust core runtime library
- `crates/clawdentity-cli`: CLI binary

## Build/Test Gates

From repo root:
- `pnpm build`
- `pnpm test`
- `pnpm -r typecheck`
- `pnpm check:file-size`

From `crates/`:
- `cargo check`
- `cargo clippy --all-targets`
- `cargo test`

## Working Rules

- Keep connector APIs runtime-agnostic.
- Keep `framework` metadata optional and informational.
- Do not add runtime-specific setup or detection branches to the CLI.
- Keep docs and generated `agent-skill.md`/`skill.md` artifacts in sync.
