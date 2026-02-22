#!/usr/bin/env bash
set -euo pipefail

INTEGRATION_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "${INTEGRATION_ROOT}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${INTEGRATION_ROOT}/.env"
  set +a
fi

MOCK_REGISTRY_PORT="${MOCK_REGISTRY_PORT:-13370}"
MOCK_PROXY_PORT="${MOCK_PROXY_PORT:-13371}"
MOCK_REGISTRY_URL="${MOCK_REGISTRY_URL:-http://127.0.0.1:${MOCK_REGISTRY_PORT}}"
MOCK_PROXY_URL="${MOCK_PROXY_URL:-http://127.0.0.1:${MOCK_PROXY_PORT}}"

PROVIDER_A_SERVICE="${PROVIDER_A_SERVICE:-openclaw}"
PROVIDER_B_SERVICE="${PROVIDER_B_SERVICE:-picoclaw}"
PROVIDER_C_SERVICE="${PROVIDER_C_SERVICE:-nanobot}"
PROVIDER_A_AGENT_NAME="${PROVIDER_A_AGENT_NAME:-${OPENCLAW_AGENT_NAME:-openclaw-agent}}"
PROVIDER_B_AGENT_NAME="${PROVIDER_B_AGENT_NAME:-${PICOCLAW_AGENT_NAME:-picoclaw-agent}}"
PROVIDER_C_AGENT_NAME="${PROVIDER_C_AGENT_NAME:-${NANOBOT_AGENT_NAME:-nanobot-agent}}"
PROVIDER_A_FRAMEWORK="${PROVIDER_A_FRAMEWORK:-openclaw}"
PROVIDER_B_FRAMEWORK="${PROVIDER_B_FRAMEWORK:-picoclaw}"
PROVIDER_C_FRAMEWORK="${PROVIDER_C_FRAMEWORK:-nanobot}"

if [[ -z "${PROVIDER_C_CONNECTOR_HOST_PORT:-}" ]]; then
  case "${PROVIDER_C_SERVICE}" in
    nanoclaw) PROVIDER_C_CONNECTOR_HOST_PORT="${NANOCLAW_CONNECTOR_HOST_PORT:-19440}" ;;
    *) PROVIDER_C_CONNECTOR_HOST_PORT="${NANOBOT_CONNECTOR_HOST_PORT:-19430}" ;;
  esac
fi

PROVIDER_A_CONNECTOR_HOST_PORT="${PROVIDER_A_CONNECTOR_HOST_PORT:-${OPENCLAW_CONNECTOR_HOST_PORT:-19410}}"
PROVIDER_B_CONNECTOR_HOST_PORT="${PROVIDER_B_CONNECTOR_HOST_PORT:-${PICOCLAW_CONNECTOR_HOST_PORT:-19420}}"

compose() {
  docker compose --env-file "${INTEGRATION_ROOT}/.env" -f "${INTEGRATION_ROOT}/docker-compose.yml" "$@"
}

pass() {
  printf 'PASS: %s\n' "$*"
}

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_eq() {
  local expected="$1"
  local actual="$2"
  local label="$3"
  if [[ "${expected}" == "${actual}" ]]; then
    pass "${label}"
    return 0
  fi
  fail "${label} (expected='${expected}', actual='${actual}')"
}

wait_for_health() {
  local url="$1"
  local label="$2"
  local attempts="${3:-90}"
  local sleep_seconds="${4:-1}"
  local i
  for ((i = 1; i <= attempts; i += 1)); do
    if curl -fsS "${url}" >/dev/null 2>&1; then
      pass "${label} healthy"
      return 0
    fi
    sleep "${sleep_seconds}"
  done
  fail "${label} health check timed out (${url})"
}

run_in_container() {
  local service="$1"
  shift
  local cmd="$*"
  compose exec -T "${service}" sh -lc "${cmd}"
}

container_home_for_service() {
  case "$1" in
    openclaw) printf '%s\n' '/var/lib/clawdentity/openclaw' ;;
    picoclaw) printf '%s\n' '/var/lib/clawdentity/picoclaw' ;;
    nanobot) printf '%s\n' '/var/lib/clawdentity/nanobot' ;;
    nanoclaw) printf '%s\n' '/var/lib/clawdentity/nanoclaw' ;;
    *) fail "unknown service: $1" ;;
  esac
}

agent_did() {
  local service="$1"
  local agent_name="$2"
  local home_dir
  home_dir="$(container_home_for_service "${service}")"
  run_in_container "${service}" \
    "clawdentity --home-dir '${home_dir}' --json agent inspect '${agent_name}' | jq -r '.did'"
}

agent_framework() {
  local service="$1"
  local agent_name="$2"
  local home_dir
  home_dir="$(container_home_for_service "${service}")"
  run_in_container "${service}" \
    "clawdentity --home-dir '${home_dir}' --json agent inspect '${agent_name}' | jq -r '.framework'"
}

agent_ait() {
  local service="$1"
  local agent_name="$2"
  local home_dir
  home_dir="$(container_home_for_service "${service}")"
  run_in_container "${service}" \
    "tr -d '\n' < '${home_dir}/.clawdentity/states/local/agents/${agent_name}/ait.jwt'"
}

delivered_count() {
  local service="$1"
  local home_dir
  home_dir="$(container_home_for_service "${service}")"
  run_in_container "${service}" \
    "sqlite3 '${home_dir}/.clawdentity/states/local/clawdentity.sqlite3' \"SELECT COUNT(*) FROM inbound_events WHERE event_type='delivered';\""
}

outbound_pending_count() {
  local service="$1"
  run_in_container "${service}" "curl -fsS http://127.0.0.1:19400/v1/status | jq -r '.outbound.queue.pendingCount'"
}

check_received() {
  local service="$1"
  local previous_count="$2"
  local label="$3"
  local attempts="${4:-60}"
  local sleep_seconds="${5:-1}"
  local i
  for ((i = 1; i <= attempts; i += 1)); do
    local current
    current="$(delivered_count "${service}")"
    if (( current > previous_count )); then
      pass "${label} (delivered count ${previous_count} -> ${current})"
      return 0
    fi
    sleep "${sleep_seconds}"
  done
  fail "${label} (no delivered event observed on ${service})"
}

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

send_message() {
  local from_service="$1"
  local to_agent_did="$2"
  local content="$3"
  local escaped_to escaped_content payload response frame_id

  escaped_to="$(json_escape "${to_agent_did}")"
  escaped_content="$(json_escape "${content}")"
  payload="{\"toAgentDid\":\"${escaped_to}\",\"payload\":{\"content\":\"${escaped_content}\"}}"
  response="$(run_in_container "${from_service}" "curl -sS -X POST http://127.0.0.1:19400/v1/outbound -H 'Content-Type: application/json' --data '${payload}'")"
  if ! jq -e '.accepted == true' >/dev/null 2>&1 <<<"${response}"; then
    fail "${from_service} rejected outbound message payload: ${response}"
  fi
  frame_id="$(jq -r '.frameId // empty' <<<"${response}")"
  pass "${from_service} accepted outbound message"
  printf '%s\n' "${frame_id}"
}
