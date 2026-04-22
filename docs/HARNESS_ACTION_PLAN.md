# Action Plan: Agent-First Engineering for Clawdentity

Inspired by [OpenAI's Harness Engineering](https://openai.com/index/harness-engineering/) — applying their learnings to how we build Clawdentity with Codex.

## Phase 1: Fix Review Findings (Pre-Merge)

From REVIEW.md — must land before PR #180 merges.

| # | Severity | Issue | File |
|---|----------|-------|------|
| 1 | CRITICAL | ACK sent even when inbound persistence fails → silent data loss | connector.rs:457 |
| 2 | HIGH | `install` returns exit 0 when verification is unhealthy | install.rs:103 |
| 3 | HIGH | Heartbeat ACK timeout bypassed by tick ordering | client.rs:303 |
| 4 | HIGH | Runtime adapter module exceeds line budget — split by responsibility | adapter module |
| 5 | MEDIUM | `config init` swallows registry metadata failures | main.rs:175 |
| 6 | MEDIUM | `config get --json` emits plain text, not JSON | main.rs:203 |
| 7 | MEDIUM | Malformed outbound payloads dropped silently | relay.rs:32 |
| 8 | MEDIUM | API key status parsing too strict for forward compat | api_key.rs:131 |

## Phase 2: Repository Knowledge Structure

**Goal:** AGENTS.md as table of contents (~100 lines), docs/ as system of record.

### 2.1 Create docs/ structure
```
docs/
├── ARCHITECTURE.md       # Module map, dependency rules, layer diagram
├── DESIGN_DECISIONS.md   # Key choices with rationale (DID format, single binary, etc.)
├── QUALITY.md            # Per-module quality grades (A-F), updated by agent
├── GOLDEN_PRINCIPLES.md  # Non-negotiable rules (800 lines, no unwrap, etc.)
├── HARNESS_ACTION_PLAN.md  # This file
└── plans/
    ├── active/           # In-progress execution plans
    └── completed/        # Done plans with decision logs
```

### 2.2 Slim down AGENTS.md
- Keep root `AGENTS.md` concise (~100 lines): project overview, build commands, module map, and pointers to `docs/`.
- Avoid crate-specific governance files that drift from root docs.
- Skill files stay integration-focused and should delegate system rules to root docs.

### 2.3 Execution plans as artifacts
- Every non-trivial feature gets `docs/plans/active/<name>.md`
- Contains: goal, approach, progress log, decision log, blockers
- Codex reads the plan, updates progress as it works
- Move to `completed/` when done

## Phase 3: Mechanical Enforcement

**Goal:** Rules enforced by code, not prose. Custom lints with agent-readable error messages.

### 3.1 Structural lint (cargo test)
```rust
// crates/clawdentity-core/tests/structural.rs
#[test] fn no_file_exceeds_800_lines() { ... }
#[test] fn adapter_layer_cannot_import_runtime() { ... }
#[test] fn connector_cannot_import_adapter_layer() { ... }
#[test] fn no_unwrap_outside_tests() { ... }
#[test] fn all_public_functions_documented() { ... }
```

Error messages include remediation hints:
```
FAIL: runtime_adapter.rs is 2095 lines (limit: 800).
FIX: Split adapter logic by config, setup, health checks, and delivery tests.
```

### 3.2 Dependency direction rules
```
identity/ → (nothing)
registry/ → identity/
db/ → (nothing)
connector/ → db/, identity/
runtime/ → connector/, db/
adapter/ → identity/, db/, connector/ (NOT runtime/)
pairing/ → identity/, db/
```

### 3.3 CI integration
- `cargo test -p clawdentity-core --test structural` in CI
- Blocks merge if any structural test fails
- Error messages are Codex-readable (remediation included)

## Phase 4: Agent-to-Agent Review

**Goal:** No human review required for most PRs.

### 4.1 Multi-agent review flow
1. Codex implements in `codex-impl` session
2. Codex self-reviews locally before committing
3. Two parallel Codex review agents (core + CLI) in cloud/local
4. Findings auto-consolidated → fix PR opened
5. Loop until all agent reviewers pass
6. Human reviews only when flagged

### 4.2 Review automation script
```bash
# scripts/agent-review.sh
# Runs structural tests, clippy, then spawns Codex review
cargo test -p clawdentity-core --test structural
cargo clippy --workspace --all-targets -- -D warnings
cargo test
# If all pass, open PR with "agent-approved" label
```

## Phase 5: Garbage Collection

**Goal:** Continuous quality, not Friday cleanup.

### 5.1 Doc-gardening agent (weekly cron)
- Scans docs/ for stale content vs actual code
- Checks ARCHITECTURE.md module list matches `find src -type d`
- Updates QUALITY.md grades
- Opens fix-up PRs

### 5.2 Code quality sweep (weekly cron)
- Scans for duplicated patterns (registry error parsing, adapter presentation)
- Checks for files approaching 800-line limit (warn at 600)
- Flags test coverage gaps in critical paths
- Opens refactoring PRs

### 5.3 Golden principles enforcement
Codified in `docs/GOLDEN_PRINCIPLES.md`, enforced in `crates/clawdentity-core/tests/structural.rs`:
1. No file over 800 lines
2. No unwrap/panic outside tests
3. All errors are actionable (context + remediation)
4. Public API is minimal (minimize `pub` surface)
5. Dependencies flow forward (see layer rules)
6. Tests cover failure branches, not just happy paths
7. JSON output is consistent across all commands
8. Boring tech preferred (composable, stable, well-documented)

## Phase 6: Parallel Worktrees

**Goal:** Multiple Codex agents working simultaneously.

### 6.1 Worktree setup
```bash
# Each Codex session gets its own worktree
git worktree add ../clawdentity-wt-review feat/rust-cli
git worktree add ../clawdentity-wt-fix feat/rust-cli

# Session per worktree
tmux new-session -d -s codex-impl -c ../clawdentity/crates
tmux new-session -d -s codex-review -c ../clawdentity-wt-review/crates
tmux new-session -d -s codex-fix -c ../clawdentity-wt-fix/crates
```

### 6.2 Merge strategy
- Short-lived branches per task
- Agent opens PR, agent reviews, agent merges
- Conflicts resolved by agent (or escalated)

## Implementation Order

1. **Now:** Phase 1 (fix review findings) — Codex session
2. **This week:** Phase 2.1 + 2.2 (docs structure + AGENTS.md)
3. **This week:** Phase 3.1 + 3.2 (structural lint + dependency rules)
4. **Next week:** Phase 4 (agent-to-agent review)
5. **Next week:** Phase 5 (garbage collection crons)
6. **Ongoing:** Phase 6 (parallel worktrees as needed)
7. **Release practice:** Keep `.github/workflows/publish-rust.yml` as the single source for Rust release automation, derive versions using `cargo info` metadata (not direct crates.io API calls), and verify duplicate tag creation before publishing.

## Success Metrics

- Zero files over 800 lines (currently 1 violation)
- All PRs pass structural tests before merge
- Review cycle time < 30 min (agent-to-agent)
- No manual cleanup sprints needed
- docs/ stays current with code (verified by gardening agent)
