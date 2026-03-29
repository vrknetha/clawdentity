# AGENTS.md (crates root)

## Purpose
- Keep Rust workspace defaults fast for local development while preserving predictable release behavior.

## Rules
- Development profile tuning must only target feedback speed (`profile.dev`, `profile.test`) and must not silently weaken `profile.release`.
- Keep incremental compilation enabled for `dev` and `test` profiles unless there is a measured reason to disable it.
- Keep crates.io index protocol set to sparse in workspace cargo config for faster dependency metadata fetches.
- Any change to Rust workspace profile defaults must be validated with `cargo check` from `crates/`.
