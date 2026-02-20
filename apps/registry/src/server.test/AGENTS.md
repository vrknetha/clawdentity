# AGENTS.md - `apps/registry/src/server.test`

## Purpose
- Keep registry server tests modular, deterministic, and easy to maintain.
- Preserve behavior while allowing focused edits by route/concern.

## Organization Rules
- Keep each `*.test.ts` file focused on one route or tightly related route concern.
- Keep each `*.test.ts` file under 800 lines.
- Keep `helpers.ts` as a thin public export shim used by tests.
- Place shared helper implementation in `helpers/**` with focused modules (`claims`, `crypto`, `pat`, `agent-registration`, `db/*`); do not duplicate harness logic across test files.
- Prefer adding small helper functions in the appropriate `helpers/**` module when setup repeats 3+ times.
- Keep every file under `server.test` (including `helpers/**`) below 800 lines.

## Agent registration create test split
- Split `agent-registration-create` specs into focused files:
  - `agent-registration-create-validation.test.ts` for auth, general payload validation, and environment-specific error messaging.
  - `agent-registration-create-challenge.test.ts` for challenge lifecycle errors (missing, invalid proof, replayed challenge) and shared challenge fixtures.
  - `agent-registration-create-success.test.ts` for the happy path responses, default values, persisted records, and AIT verification.
  - `agent-registration-create-config.test.ts` for configuration/500-level failures such as missing/mismatched signing keys.
- Each file should `import { createRegistryApp } from "../server.js"` and only add helpers needed for that concern.

## Shared helpers
- Add a `helpers/agent-registration.ts` module that exposes curated builders (e.g., `makeRegistrationChallenge`, `makeValidRegistrationPayload`, `makeRegistrySigningKeys`) so new files re-use deterministic data and signing-key sets.
- Keep `helpers/pat.ts` focused on PAT fixtures, and reuse `helpers/crypto.ts` for keypair/signature helpers across all registration tests.
- Export any new helper from `helpers.ts` so new spec files can `import { makeRegistrySigningKeys } from "./helpers.js"` and stay concise.

## Change Rules
- Preserve existing assertions and response contracts when refactoring test structure.
- When adding tests, keep test names explicit about endpoint, auth mode, and expected status.
- Favor deterministic fixtures (fixed IDs/timestamps/nonces) over random values.
- Avoid coupling tests to execution order; each test must be independently runnable.

## Route Coverage
- Maintain separate coverage for:
  - health/metadata/admin bootstrap
  - key publication + CRL
  - resolve + me
  - invites
  - me API keys
  - agents listing/ownership/internal auth
  - agent lifecycle (delete/reissue)
  - registration challenge/create
  - agent auth refresh/validate/revoke
- Keep `POST /v1/agents` registration-create coverage split by concern:
  - `agent-registration-create.validation.test.ts`
  - `agent-registration-create.challenge.test.ts`
  - `agent-registration-create.success.test.ts`
  - `agent-registration-create.config.test.ts`

## Validation
- For server test changes, run:
  - `pnpm -C apps/registry typecheck`
  - `pnpm -C apps/registry test -- server`
