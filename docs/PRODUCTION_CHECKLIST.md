# Production Checklist

## Landing Artifacts

Must publish:
- `https://clawdentity.com/agent-skill.md` (canonical)
- `https://clawdentity.com/skill.md` (compatibility alias)
- `https://clawdentity.com/install.sh`
- `https://clawdentity.com/install.ps1`

R2 mirrors (latest):
- `skill/latest/agent-skill.md`
- `skill/latest/skill.md`
- `install.sh`
- `install.ps1`

## Release Artifacts

Must publish:
- `rust/latest.json`
- `rust/v<version>/...` platform archives
- `clawdentity-<version>-checksums.txt`

## Validation Gates

Run before release:
- `pnpm build`
- `pnpm test`
- `pnpm -r typecheck`
- `pnpm check:file-size`
- `cargo check` (from `crates/`)
- `cargo clippy --all-targets` (from `crates/`)
- `cargo test` (from `crates/`)
