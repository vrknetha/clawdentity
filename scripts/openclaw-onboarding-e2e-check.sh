#!/usr/bin/env bash

set -euo pipefail

ALPHA_CONTAINER="${ALPHA_CONTAINER:-clawdbot-agent-alpha-1}"
BETA_CONTAINER="${BETA_CONTAINER:-clawdbot-agent-beta-1}"
CLAWDENTITY_BIN="${CLAWDENTITY_BIN:-clawdentity}"
PLATFORM="${PLATFORM:-openclaw}"
PAIR_WAIT_SECONDS="${PAIR_WAIT_SECONDS:-30}"
PAIR_POLL_INTERVAL_SECONDS="${PAIR_POLL_INTERVAL_SECONDS:-3}"
READY_WAIT_ATTEMPTS="${READY_WAIT_ATTEMPTS:-10}"
READY_WAIT_SLEEP_SECONDS="${READY_WAIT_SLEEP_SECONDS:-3}"
USE_REPAIR="${USE_REPAIR:-1}"

ALPHA_AGENT_NAME="${ALPHA_AGENT_NAME:-alpha-local}"
BETA_AGENT_NAME="${BETA_AGENT_NAME:-beta-local}"
ALPHA_DISPLAY_NAME="${ALPHA_DISPLAY_NAME:-Alpha Local}"
BETA_DISPLAY_NAME="${BETA_DISPLAY_NAME:-Beta Local}"
ALPHA_ONBOARDING_CODE="${ALPHA_ONBOARDING_CODE:-}"
BETA_ONBOARDING_CODE="${BETA_ONBOARDING_CODE:-}"

log() {
  printf '[openclaw-onboarding-e2e] %s\n' "$*"
}

fail() {
  printf '[openclaw-onboarding-e2e] ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

require_non_empty() {
  local name="$1"
  local value="$2"
  [[ -n "$value" ]] || fail "Missing required environment variable: ${name}"
}

shell_escape() {
  printf '%q' "$1"
}

run_in_container() {
  local container="$1"
  local command="$2"
  docker exec "$container" sh -lc "$command"
}

run_json_in_container() {
  local container="$1"
  local command="$2"
  run_in_container "$container" "$command --json"
}

json_field() {
  local field_path="$1"
  node -e '
    const raw = require("fs").readFileSync(0, "utf8").trim();
    const payload = JSON.parse(raw);
    const path = process.argv[1].split(".");
    let current = payload;
    for (const segment of path) {
      if (current === null || typeof current !== "object" || !(segment in current)) {
        process.exit(2);
      }
      current = current[segment];
    }
    if (current === null || current === undefined) {
      process.exit(2);
    }
    if (typeof current === "string") {
      process.stdout.write(current);
      process.exit(0);
    }
    process.stdout.write(JSON.stringify(current));
  ' "$field_path"
}

onboarding_run_json() {
  local container="$1"
  local onboarding_code="$2"
  local display_name="$3"
  local agent_name="$4"
  local peer_ticket="$5"

  local cmd
  cmd="$(shell_escape "$CLAWDENTITY_BIN") onboarding run"
  cmd+=" --for $(shell_escape "$PLATFORM")"
  cmd+=" --onboarding-code $(shell_escape "$onboarding_code")"
  cmd+=" --display-name $(shell_escape "$display_name")"
  cmd+=" --agent-name $(shell_escape "$agent_name")"
  cmd+=" --pair-wait-seconds $(shell_escape "$PAIR_WAIT_SECONDS")"
  cmd+=" --pair-poll-interval-seconds $(shell_escape "$PAIR_POLL_INTERVAL_SECONDS")"
  if [[ -n "$peer_ticket" ]]; then
    cmd+=" --peer-ticket $(shell_escape "$peer_ticket")"
  fi
  if [[ "$USE_REPAIR" == "1" ]]; then
    cmd+=" --repair"
  fi

  run_json_in_container "$container" "$cmd"
}

provider_doctor_status() {
  local container="$1"
  local cmd
  cmd="$(shell_escape "$CLAWDENTITY_BIN") provider doctor"
  cmd+=" --for $(shell_escape "$PLATFORM")"
  local output
  output="$(run_json_in_container "$container" "$cmd")"
  printf '%s' "$output" | json_field status
}

provider_relay_test_status() {
  local container="$1"
  local peer_alias="$2"
  local message="$3"
  local cmd
  cmd="$(shell_escape "$CLAWDENTITY_BIN") provider relay-test"
  cmd+=" --for $(shell_escape "$PLATFORM")"
  cmd+=" --peer $(shell_escape "$peer_alias")"
  cmd+=" --message $(shell_escape "$message")"
  local output
  output="$(run_json_in_container "$container" "$cmd")"
  printf '%s' "$output" | json_field status
}

wait_until_ready() {
  local container="$1"
  local onboarding_code="$2"
  local display_name="$3"
  local agent_name="$4"
  local peer_ticket="$5"

  local attempt
  for ((attempt = 1; attempt <= READY_WAIT_ATTEMPTS; attempt += 1)); do
    local output
    output="$(onboarding_run_json "$container" "$onboarding_code" "$display_name" "$agent_name" "$peer_ticket")"
    local status
    status="$(printf '%s' "$output" | json_field status || true)"
    if [[ "$status" == "ready" ]]; then
      printf '%s' "$output"
      return 0
    fi

    if [[ "$attempt" -lt "$READY_WAIT_ATTEMPTS" ]]; then
      sleep "$READY_WAIT_SLEEP_SECONDS"
    fi
  done

  return 1
}

run() {
  require_command docker
  require_command node
  require_non_empty ALPHA_ONBOARDING_CODE "$ALPHA_ONBOARDING_CODE"
  require_non_empty BETA_ONBOARDING_CODE "$BETA_ONBOARDING_CODE"

  log "Running onboarding on alpha to produce pairing ticket"
  local alpha_first
  alpha_first="$(onboarding_run_json "$ALPHA_CONTAINER" "$ALPHA_ONBOARDING_CODE" "$ALPHA_DISPLAY_NAME" "$ALPHA_AGENT_NAME" "")"
  local ticket
  ticket="$(printf '%s' "$alpha_first" | json_field ticket || true)"
  [[ -n "$ticket" ]] || fail "Alpha onboarding did not produce a pairing ticket"

  log "Running onboarding on beta with alpha ticket"
  local beta_ready
  beta_ready="$(wait_until_ready "$BETA_CONTAINER" "$BETA_ONBOARDING_CODE" "$BETA_DISPLAY_NAME" "$BETA_AGENT_NAME" "$ticket")" \
    || fail "Beta onboarding did not reach ready state"

  log "Re-running onboarding on alpha to finalize pair acceptance"
  local alpha_ready
  alpha_ready="$(wait_until_ready "$ALPHA_CONTAINER" "$ALPHA_ONBOARDING_CODE" "$ALPHA_DISPLAY_NAME" "$ALPHA_AGENT_NAME" "")" \
    || fail "Alpha onboarding did not reach ready state"

  local alpha_peer_alias
  alpha_peer_alias="$(printf '%s' "$alpha_ready" | json_field peerAlias || true)"
  local beta_peer_alias
  beta_peer_alias="$(printf '%s' "$beta_ready" | json_field peerAlias || true)"
  [[ -n "$alpha_peer_alias" ]] || fail "Alpha ready output is missing peerAlias"
  [[ -n "$beta_peer_alias" ]] || fail "Beta ready output is missing peerAlias"

  log "Checking provider doctor health on alpha and beta"
  local alpha_doctor_status
  alpha_doctor_status="$(provider_doctor_status "$ALPHA_CONTAINER")"
  local beta_doctor_status
  beta_doctor_status="$(provider_doctor_status "$BETA_CONTAINER")"
  [[ "$alpha_doctor_status" == "healthy" ]] || fail "Alpha provider doctor is not healthy"
  [[ "$beta_doctor_status" == "healthy" ]] || fail "Beta provider doctor is not healthy"

  log "Running bidirectional relay tests"
  local alpha_relay_status
  alpha_relay_status="$(provider_relay_test_status "$ALPHA_CONTAINER" "$alpha_peer_alias" "hello from alpha e2e")"
  local beta_relay_status
  beta_relay_status="$(provider_relay_test_status "$BETA_CONTAINER" "$beta_peer_alias" "hello from beta e2e")"
  [[ "$alpha_relay_status" == "success" ]] || fail "Alpha relay test failed"
  [[ "$beta_relay_status" == "success" ]] || fail "Beta relay test failed"

  log "E2E onboarding check passed"
  printf 'alpha_peer_alias=%s\n' "$alpha_peer_alias"
  printf 'beta_peer_alias=%s\n' "$beta_peer_alias"
}

run
