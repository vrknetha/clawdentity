# AGENTS.md (packages/common)

## Purpose
- Provide small, dependency-light shared helpers used across packages.

## Design Rules
- Keep helpers pure and runtime-agnostic.
- Keep API surface minimal and stable.
- Avoid domain-specific logic that belongs in feature packages.
- Prefer composable utility functions over class-heavy abstractions.
- Keep shared HTTP response parsing helpers (for example safe JSON parsing) in this package so apps/packages do not duplicate try/catch wrappers.
- Keep shared request-origin and loopback-hostname helpers here when multiple apps need identical forwarded-header behavior; do not let proxy and registry drift with copy-pasted URL parsing logic.
