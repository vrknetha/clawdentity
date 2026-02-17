# AGENTS.md (apps/cli/scripts)

## Purpose
- Keep CLI helper scripts deterministic and safe for release packaging.

## Rules
- `sync-skill-bundle.mjs` is the source of truth for copying OpenClaw skill assets into `apps/cli/skill-bundle/`.
- `openclaw-relay-docker-e2e.sh` is the source of truth for local-only Docker-based OpenClaw relay E2E validation (invite onboarding, skill artifacts, bidirectional relay, and connector failure/recovery checks).
- Scripts must fail with actionable errors when required source artifacts are missing.
- Docker E2E skill install must use strict global package root `clawdentity` only and fail fast when `postinstall.mjs` is missing (no backward-compatibility fallback).
- Docker E2E scripts must keep reset behavior explicit (`RESET_MODE=skill|full|none`) and must only remove known skill-generated files in skill-reset mode.
- Docker E2E relay scripts should accept `CLAWDENTITY_E2E_PAT`, but when absent they must first attempt to reuse existing container CLI config PAT before fallback bootstrap so pre-bootstrapped environments remain runnable.
- Connector startup failures in Docker E2E should include the agent DID in diagnostics so operator allowlist mismatches can be fixed quickly.
- Keep script output concise and stable for CI/release logs.
- Do not add install-time network fetches to packaging scripts.
