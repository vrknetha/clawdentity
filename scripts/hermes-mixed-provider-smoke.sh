#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

CLAWDENTITY_ENV_FILE="${CLAWDENTITY_ENV_FILE:-${REPO_ROOT}/.env}"
OPENCLAW_RESET_SCRIPT="${OPENCLAW_RESET_SCRIPT:-${SCRIPT_DIR}/openclaw-relay-docker-ready.sh}"
OPENCLAW_ONBOARDING_SCRIPT="${OPENCLAW_ONBOARDING_SCRIPT:-${SCRIPT_DIR}/openclaw-onboarding-e2e-check.sh}"

ALPHA_CONTAINER="${ALPHA_CONTAINER:-clawdbot-agent-alpha-1}"
BETA_CONTAINER="${BETA_CONTAINER:-clawdbot-agent-beta-1}"

ALPHA_AGENT_NAME="${ALPHA_AGENT_NAME:-alpha-local}"
BETA_AGENT_NAME="${BETA_AGENT_NAME:-beta-local}"
HERMES_AGENT_NAME="${HERMES_AGENT_NAME:-gamma-hermes}"
HERMES_DISPLAY_NAME="${HERMES_DISPLAY_NAME:-Gamma Hermes}"

OPENCLAW_ALPHA_HOME="${OPENCLAW_ALPHA_HOME:-$HOME/.openclaw-alpha}"
OPENCLAW_BETA_HOME="${OPENCLAW_BETA_HOME:-$HOME/.openclaw-beta}"
HERMES_HOME_ROOT="${HERMES_HOME_ROOT:-/tmp/clawdentity-hermes-home}"
HERMES_HOME_DIR="${HERMES_HOME_ROOT}/.hermes"
HERMES_STATE_DIR="${HERMES_HOME_ROOT}/.clawdentity/states/local"
HERMES_STATE_DB="${HERMES_STATE_DIR}/clawdentity.sqlite3"

HERMES_CONTAINER="${HERMES_CONTAINER:-clawdentity-hermes-smoke}"
HERMES_IMAGE="${HERMES_IMAGE:-nousresearch/hermes-agent:latest}"
HERMES_WEBHOOK_PORT="${HERMES_WEBHOOK_PORT:-8644}"
HERMES_CONNECTOR_PORT="${HERMES_CONNECTOR_PORT:-19430}"
HERMES_SEED_HOME="${HERMES_SEED_HOME:-$HOME/.hermes}"
HERMES_SEED_CONFIG_FILE="${HERMES_SEED_CONFIG_FILE:-${HERMES_SEED_HOME}/config.yaml}"
HERMES_SEED_ENV_FILE="${HERMES_SEED_ENV_FILE:-${HERMES_SEED_HOME}/.env}"
HOST_CODEX_AUTH_FILE="${HOST_CODEX_AUTH_FILE:-$HOME/.codex/auth.json}"
HERMES_PROFILE_PROVIDER="${HERMES_PROFILE_PROVIDER:-openrouter}"
HERMES_PROFILE_MODEL="${HERMES_PROFILE_MODEL:-moonshotai/kimi-k2.5}"
HERMES_FALLBACK_PROVIDER="${HERMES_FALLBACK_PROVIDER:-openai-codex}"
HERMES_FALLBACK_MODEL="${HERMES_FALLBACK_MODEL:-gpt-5.4}"
HERMES_EFFECTIVE_PROVIDER=""
HERMES_EFFECTIVE_MODEL=""
HERMES_MODEL_PATH=""
HERMES_CODEX_HOME_DIR="${HERMES_HOME_DIR}/.codex"

HOST_REGISTRY_URL="${HOST_REGISTRY_URL:-${CLAWDENTITY_REGISTRY_URL:-http://127.0.0.1:8788}}"
DOCKER_REGISTRY_URL="${DOCKER_REGISTRY_URL:-http://host.docker.internal:8788}"
DOCKER_PROXY_URL="${DOCKER_PROXY_URL:-http://host.docker.internal:8787}"
DOCKER_SITE_BASE_URL="${DOCKER_SITE_BASE_URL:-http://host.docker.internal:4321}"

RESET_OPENCLAW="${RESET_OPENCLAW:-1}"
RUN_OPENCLAW_ONBOARDING="${RUN_OPENCLAW_ONBOARDING:-1}"
RESET_HERMES_HOME="${RESET_HERMES_HOME:-1}"
REQUIRE_APP_REGISTRY_GROUPS_ROUTE="${REQUIRE_APP_REGISTRY_GROUPS_ROUTE:-1}"
WAIT_ATTEMPTS="${WAIT_ATTEMPTS:-60}"
WAIT_SLEEP_SECONDS="${WAIT_SLEEP_SECONDS:-2}"
PAIR_WAIT_SECONDS="${PAIR_WAIT_SECONDS:-60}"
PAIR_POLL_INTERVAL_SECONDS="${PAIR_POLL_INTERVAL_SECONDS:-2}"

ALPHA_ONBOARDING_CODE="${ALPHA_ONBOARDING_CODE:-}"
BETA_ONBOARDING_CODE="${BETA_ONBOARDING_CODE:-}"
HERMES_INVITE_CODE="${HERMES_INVITE_CODE:-}"

RUN_ID="$(date +%Y%m%d%H%M%S)"
DIRECT_MESSAGE="hermes-direct-smoke-${RUN_ID}"
GROUP_MESSAGE="hermes-group-smoke-${RUN_ID}"
RELAY_TEST_MESSAGE="hermes-relay-test-${RUN_ID}"
GROUP_NAME="mixed-provider-smoke-${RUN_ID}"

HERMES_BIN_DIR=""
HERMES_CONNECTOR_PID=""

log() {
  printf '[hermes-mixed-provider-smoke] %s\n' "$*"
}

fail() {
  printf '[hermes-mixed-provider-smoke] ERROR: %s\n' "$*" >&2
  exit 1
}

resolve_hermes_model_profile() {
  if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    HERMES_MODEL_PATH="openrouter"
    HERMES_EFFECTIVE_PROVIDER="${HERMES_PROFILE_PROVIDER}"
    HERMES_EFFECTIVE_MODEL="${HERMES_PROFILE_MODEL}"
    log "Using OpenRouter model profile ${HERMES_EFFECTIVE_PROVIDER}:${HERMES_EFFECTIVE_MODEL}"
    return 0
  fi

  HERMES_MODEL_PATH="codex"
  HERMES_EFFECTIVE_PROVIDER="${HERMES_FALLBACK_PROVIDER}"
  HERMES_EFFECTIVE_MODEL="${HERMES_FALLBACK_MODEL}"
  log "OPENROUTER_API_KEY not set; using Codex fallback ${HERMES_EFFECTIVE_PROVIDER}:${HERMES_EFFECTIVE_MODEL}"
}

cleanup() {
  set +e

  if [[ -n "${HERMES_CONNECTOR_PID}" ]] && kill -0 "${HERMES_CONNECTOR_PID}" >/dev/null 2>&1; then
    kill "${HERMES_CONNECTOR_PID}" >/dev/null 2>&1 || true
    wait "${HERMES_CONNECTOR_PID}" >/dev/null 2>&1 || true
  fi

  if docker ps -a --format '{{.Names}}' | grep -Fx "${HERMES_CONTAINER}" >/dev/null 2>&1; then
    docker rm -f "${HERMES_CONTAINER}" >/dev/null 2>&1 || true
  fi

  if [[ -n "${HERMES_BIN_DIR}" && -d "${HERMES_BIN_DIR}" ]]; then
    rm -rf "${HERMES_BIN_DIR}"
  fi
}

trap cleanup EXIT

load_dotenv() {
  local env_file="$1"
  [[ -f "${env_file}" ]] || return 0
  set -a
  set +u
  # shellcheck disable=SC1090
  source "${env_file}"
  set -u
  set +a
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

require_file() {
  [[ -f "$1" ]] || fail "File not found: $1"
}

require_dir() {
  [[ -d "$1" ]] || fail "Directory not found: $1"
}

require_non_empty() {
  local name="$1"
  local value="$2"
  [[ -n "${value}" ]] || fail "Missing required environment variable: ${name}"
}

upsert_env_value() {
  local env_file="$1"
  local key="$2"
  local value="$3"
  local tmp_file

  tmp_file="$(mktemp)"
  awk -v key="${key}" -v value="${value}" '
    BEGIN { replaced = 0 }
    {
      if ($0 ~ "^[[:space:]]*" key "=") {
        print key "=" value
        replaced = 1
        next
      }
      print
    }
    END {
      if (replaced == 0) {
        print key "=" value
      }
    }
  ' "${env_file}" >"${tmp_file}"

  mv "${tmp_file}" "${env_file}"
}

resolve_host_clawdentity_bin() {
  if [[ -n "${CLAWDENTITY_HOST_BIN:-}" ]]; then
    [[ -x "${CLAWDENTITY_HOST_BIN}" ]] || fail "CLAWDENTITY_HOST_BIN is not executable: ${CLAWDENTITY_HOST_BIN}"
    printf '%s\n' "${CLAWDENTITY_HOST_BIN}"
    return 0
  fi

  if [[ -x "${REPO_ROOT}/crates/target/debug/clawdentity-cli" ]]; then
    printf '%s\n' "${REPO_ROOT}/crates/target/debug/clawdentity-cli"
    return 0
  fi

  if command -v clawdentity >/dev/null 2>&1; then
    command -v clawdentity
    return 0
  fi

  fail "Unable to resolve a host clawdentity binary. Set CLAWDENTITY_HOST_BIN or build crates/target/debug/clawdentity-cli first."
}

run_host_cli() {
  local clawd_bin="$1"
  shift
  PATH="${HERMES_BIN_DIR}:${PATH}" "${clawd_bin}" --home-dir "${HERMES_HOME_ROOT}" "$@"
}

run_host_json() {
  local clawd_bin="$1"
  shift
  run_host_cli "${clawd_bin}" --json "$@"
}

run_container() {
  local container="$1"
  shift
  docker exec "${container}" sh -lc "$*"
}

wait_for_http_ok() {
  local url="$1"
  local label="$2"
  local attempts="${3:-${WAIT_ATTEMPTS}}"
  local i

  for ((i = 1; i <= attempts; i += 1)); do
    if curl -fsS --max-time 5 "${url}" >/dev/null 2>&1; then
      log "${label} is ready"
      return 0
    fi
    sleep "${WAIT_SLEEP_SECONDS}"
  done

  fail "${label} did not become ready: ${url}"
}

require_registry_groups_route_host() {
  local base_url="$1"
  local url="${base_url%/}/v1/groups"
  local status_code
  status_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 -X POST "$url" -H 'content-type: application/json' --data '{}')"
  if [[ "$status_code" == "404" ]]; then
    fail "registry groups route check failed: ${url} returned 404 (likely mock-registry). Start apps/registry local runtime on ${base_url}."
  fi
}

wait_for_file() {
  local path="$1"
  local label="$2"
  local attempts="${3:-${WAIT_ATTEMPTS}}"
  local i

  for ((i = 1; i <= attempts; i += 1)); do
    if [[ -f "${path}" ]]; then
      log "${label} is ready"
      return 0
    fi
    sleep "${WAIT_SLEEP_SECONDS}"
  done

  fail "${label} did not appear: ${path}"
}

sqlite_scalar() {
  local db_path="$1"
  local sql="$2"
  sqlite3 "${db_path}" "${sql}" | tr -d '\n'
}

delivered_count_from_db() {
  local db_path="$1"
  sqlite_scalar "${db_path}" "SELECT COUNT(*) FROM inbound_events WHERE event_type='delivered';"
}

wait_for_delivered_count_increase() {
  local db_path="$1"
  local previous_count="$2"
  local label="$3"
  local attempts="${4:-${WAIT_ATTEMPTS}}"
  local i

  for ((i = 1; i <= attempts; i += 1)); do
    local current_count
    current_count="$(delivered_count_from_db "${db_path}")"
    if (( current_count > previous_count )); then
      log "${label} delivered count ${previous_count} -> ${current_count}"
      return 0
    fi
    sleep "${WAIT_SLEEP_SECONDS}"
  done

  fail "${label} did not record a delivered event"
}

ensure_openclaw_runtime_ready() {
  run_container "${ALPHA_CONTAINER}" "curl -fsS http://127.0.0.1:19400/v1/status >/dev/null"
  run_container "${BETA_CONTAINER}" "curl -fsS http://127.0.0.1:19400/v1/status >/dev/null"
  log "Alpha and beta connector runtimes are ready"
}

prepare_hermes_home() {
  require_file "${HERMES_SEED_CONFIG_FILE}"
  require_file "${HERMES_SEED_ENV_FILE}"
  if [[ "${HERMES_MODEL_PATH}" == "codex" ]]; then
    require_file "${HOST_CODEX_AUTH_FILE}"
  fi

  if [[ "${RESET_HERMES_HOME}" == "1" ]]; then
    rm -rf "${HERMES_HOME_ROOT}"
  fi

  mkdir -p "${HERMES_HOME_DIR}"
  mkdir -p "${HERMES_CODEX_HOME_DIR}"
  cp "${HERMES_SEED_CONFIG_FILE}" "${HERMES_HOME_DIR}/config.yaml"
  cp "${HERMES_SEED_ENV_FILE}" "${HERMES_HOME_DIR}/.env"
  if [[ -f "${HOST_CODEX_AUTH_FILE}" ]]; then
    cp "${HOST_CODEX_AUTH_FILE}" "${HERMES_CODEX_HOME_DIR}/auth.json"
  fi
  if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    upsert_env_value "${HERMES_HOME_DIR}/.env" "OPENROUTER_API_KEY" "${OPENROUTER_API_KEY}"
  fi
  mkdir -p "${HERMES_HOME_ROOT}/logs"

  log "Prepared isolated Hermes home at ${HERMES_HOME_ROOT}"
}

docker_host_gateway_args() {
  case "$(uname -s)" in
    Linux) printf '%s\n' "--add-host host.docker.internal:host-gateway" ;;
    *) printf '%s\n' "" ;;
  esac
}

start_hermes_container() {
  local extra_host_arg
  extra_host_arg="$(docker_host_gateway_args)"

  docker rm -f "${HERMES_CONTAINER}" >/dev/null 2>&1 || true

  # The official Hermes image uses /opt/data as HERMES_HOME.
  if [[ -n "${extra_host_arg}" ]]; then
    docker run -d \
      --name "${HERMES_CONTAINER}" \
      ${extra_host_arg} \
      -e CODEX_HOME=/opt/data/.codex \
      -p "${HERMES_WEBHOOK_PORT}:${HERMES_WEBHOOK_PORT}" \
      -v "${HERMES_HOME_DIR}:/opt/data" \
      "${HERMES_IMAGE}" \
      gateway run >/dev/null
  else
    docker run -d \
      --name "${HERMES_CONTAINER}" \
      -e CODEX_HOME=/opt/data/.codex \
      -p "${HERMES_WEBHOOK_PORT}:${HERMES_WEBHOOK_PORT}" \
      -v "${HERMES_HOME_DIR}:/opt/data" \
      "${HERMES_IMAGE}" \
      gateway run >/dev/null
  fi

  sleep 5
  log "Started Hermes container ${HERMES_CONTAINER}"
}

install_hermes_cli_shim() {
  HERMES_BIN_DIR="$(mktemp -d)"
  cat >"${HERMES_BIN_DIR}/hermes" <<EOF
#!/usr/bin/env bash
exec docker exec ${HERMES_CONTAINER} hermes "\$@"
EOF
  chmod +x "${HERMES_BIN_DIR}/hermes"
  log "Installed temporary hermes CLI shim at ${HERMES_BIN_DIR}/hermes"
}

configure_hermes_model_profile() {
  run_container "${HERMES_CONTAINER}" "hermes config set model.provider '${HERMES_EFFECTIVE_PROVIDER}' >/dev/null"
  run_container "${HERMES_CONTAINER}" "hermes config set model.default '${HERMES_EFFECTIVE_MODEL}' >/dev/null"
  log "Configured Hermes profile model (${HERMES_EFFECTIVE_PROVIDER}:${HERMES_EFFECTIVE_MODEL})"
}

start_hermes_connector() {
  local clawd_bin="$1"

  local command=(
    "${clawd_bin}"
    --home-dir "${HERMES_HOME_ROOT}"
    connector start "${HERMES_AGENT_NAME}"
    --bind 127.0.0.1
    --port "${HERMES_CONNECTOR_PORT}"
  )

  "${command[@]}" >"${HERMES_HOME_ROOT}/logs/connector.log" 2>&1 &
  HERMES_CONNECTOR_PID="$!"

  wait_for_http_ok "http://127.0.0.1:${HERMES_CONNECTOR_PORT}/v1/status" "Hermes connector runtime"
}

send_outbound_from_alpha() {
  local payload="$1"
  local payload_b64 response

  payload_b64="$(printf '%s' "${payload}" | base64 | tr -d '\n')"
  response="$(
    run_container "${ALPHA_CONTAINER}" \
      "payload_file=\$(mktemp) && \
       printf '%s' '${payload_b64}' | base64 -d >\"\${payload_file}\" && \
       response=\$(curl -fsS -X POST http://127.0.0.1:19400/v1/outbound -H 'Content-Type: application/json' --data-binary @\"\${payload_file}\") && \
       rm -f \"\${payload_file}\" && \
       printf '%s' \"\${response}\""
  )"

  jq -e '.accepted == true' >/dev/null <<<"${response}" \
    || fail "Alpha connector rejected outbound payload: ${response}"
}

run() {
  load_dotenv "${CLAWDENTITY_ENV_FILE}"
  resolve_hermes_model_profile

  require_command docker
  require_command curl
  require_command jq
  require_command sqlite3
  require_file "${OPENCLAW_RESET_SCRIPT}"
  require_file "${OPENCLAW_ONBOARDING_SCRIPT}"
  require_dir "${OPENCLAW_ALPHA_HOME}"
  require_dir "${OPENCLAW_BETA_HOME}"
  if [[ "${HERMES_MODEL_PATH}" == "codex" && ! -f "${HOST_CODEX_AUTH_FILE}" ]]; then
    fail "OPENROUTER_API_KEY is not set and Codex fallback auth file is missing: ${HOST_CODEX_AUTH_FILE}"
  fi

  local clawd_bin
  clawd_bin="$(resolve_host_clawdentity_bin)"
  log "Using host clawdentity binary: ${clawd_bin}"
  if [[ "${REQUIRE_APP_REGISTRY_GROUPS_ROUTE}" == "1" ]]; then
    require_registry_groups_route_host "${HOST_REGISTRY_URL}"
  fi

  if [[ "${RESET_OPENCLAW}" == "1" ]]; then
    log "Resetting the dual OpenClaw Docker harness"
    DOCKER_REGISTRY_URL="${DOCKER_REGISTRY_URL}" \
    DOCKER_PROXY_URL="${DOCKER_PROXY_URL}" \
    DOCKER_SITE_BASE_URL="${DOCKER_SITE_BASE_URL}" \
    "${OPENCLAW_RESET_SCRIPT}"
  fi

  if [[ "${RUN_OPENCLAW_ONBOARDING}" == "1" ]]; then
    require_non_empty ALPHA_ONBOARDING_CODE "${ALPHA_ONBOARDING_CODE}"
    require_non_empty BETA_ONBOARDING_CODE "${BETA_ONBOARDING_CODE}"

    log "Running the canonical alpha/beta OpenClaw onboarding smoke"
    ALPHA_ONBOARDING_CODE="${ALPHA_ONBOARDING_CODE}" \
    BETA_ONBOARDING_CODE="${BETA_ONBOARDING_CODE}" \
    "${OPENCLAW_ONBOARDING_SCRIPT}"
  fi

  ensure_openclaw_runtime_ready

  require_non_empty HERMES_INVITE_CODE "${HERMES_INVITE_CODE}"

  prepare_hermes_home
  start_hermes_container
  install_hermes_cli_shim
  configure_hermes_model_profile

  log "Bootstrapping isolated Hermes identity"
  run_host_cli "${clawd_bin}" config init --registry-url "${HOST_REGISTRY_URL}" >/dev/null
  run_host_cli "${clawd_bin}" invite redeem "${HERMES_INVITE_CODE}" --display-name "${HERMES_DISPLAY_NAME}" --registry-url "${HOST_REGISTRY_URL}" >/dev/null
  run_host_json "${clawd_bin}" agent create "${HERMES_AGENT_NAME}" --framework hermes >/dev/null

  log "Writing Hermes provider configuration"
  run_host_cli "${clawd_bin}" provider setup --for hermes --agent-name "${HERMES_AGENT_NAME}" \
    --connector-base-url "http://127.0.0.1:${HERMES_CONNECTOR_PORT}" \
    --webhook-port "${HERMES_WEBHOOK_PORT}" >/dev/null

  log "Restarting Hermes container to pick up updated config.yaml"
  start_hermes_container

  log "Starting host-side connector runtime for ${HERMES_AGENT_NAME}"
  start_hermes_connector "${clawd_bin}"
  wait_for_file "${HERMES_STATE_DB}" "Hermes connector state database"

  log "Pairing alpha with Hermes"
  local alpha_pair_start pair_ticket gamma_pair_confirm alpha_pair_status alpha_peer_alias
  alpha_pair_start="$(run_container "${ALPHA_CONTAINER}" "clawdentity --json pair start '${ALPHA_AGENT_NAME}'")"
  pair_ticket="$(printf '%s' "${alpha_pair_start}" | jq -r '.ticket')"
  [[ "${pair_ticket}" == clwpair1_* ]] || fail "Alpha did not create a valid pairing ticket"

  gamma_pair_confirm="$(run_host_json "${clawd_bin}" pair confirm "${HERMES_AGENT_NAME}" --ticket "${pair_ticket}")"
  jq -e '.paired == true' >/dev/null <<<"${gamma_pair_confirm}" \
    || fail "Hermes pair confirm did not complete"

  alpha_pair_status="$(
    run_container "${ALPHA_CONTAINER}" \
      "clawdentity --json pair status '${ALPHA_AGENT_NAME}' --ticket '${pair_ticket}' --wait --wait-seconds ${PAIR_WAIT_SECONDS} --poll-interval-seconds ${PAIR_POLL_INTERVAL_SECONDS}"
  )"
  alpha_peer_alias="$(printf '%s' "${alpha_pair_status}" | jq -r '.peerAlias // empty')"
  [[ -n "${alpha_peer_alias}" ]] || fail "Alpha pair status did not persist a peer alias for Hermes"

  log "Running Hermes provider doctor"
  local hermes_doctor
  hermes_doctor="$(run_host_json "${clawd_bin}" provider doctor --for hermes)"
  [[ "$(printf '%s' "${hermes_doctor}" | jq -r '.status')" == "healthy" ]] \
    || fail "Hermes provider doctor is not healthy"

  log "Running Hermes provider relay-test"
  local hermes_relay_test
  hermes_relay_test="$(run_host_json "${clawd_bin}" provider relay-test --for hermes --peer "${alpha_peer_alias}" --message "${RELAY_TEST_MESSAGE}")"
  [[ "$(printf '%s' "${hermes_relay_test}" | jq -r '.status')" == "success" ]] \
    || fail "Hermes provider relay-test failed"

  log "Sending direct alpha -> Hermes message"
  local gamma_did gamma_direct_before direct_payload
  gamma_did="$(run_host_json "${clawd_bin}" agent inspect "${HERMES_AGENT_NAME}" | jq -r '.did')"
  gamma_direct_before="$(delivered_count_from_db "${HERMES_STATE_DB}")"
  direct_payload="$(jq -nc --arg to "${gamma_did}" --arg content "${DIRECT_MESSAGE}" '{toAgentDid: $to, payload: {content: $content}}')"
  send_outbound_from_alpha "${direct_payload}"
  wait_for_delivered_count_increase "${HERMES_STATE_DB}" "${gamma_direct_before}" "Hermes direct delivery"

  log "Creating mixed-provider group"
  local group_create group_id join_token_create join_token
  group_create="$(run_container "${ALPHA_CONTAINER}" "clawdentity --json group create '${GROUP_NAME}' --agent-name '${ALPHA_AGENT_NAME}'")"
  group_id="$(printf '%s' "${group_create}" | jq -r '.group.id')"
  [[ "${group_id}" == grp_* ]] || fail "Group create did not return a valid group ID"

  join_token_create="$(
    run_container "${ALPHA_CONTAINER}" \
      "clawdentity --json group join-token create '${group_id}' --agent-name '${ALPHA_AGENT_NAME}' --expires-in-seconds 3600 --max-uses 3"
  )"
  join_token="$(printf '%s' "${join_token_create}" | jq -r '.groupJoinToken.token')"
  [[ "${join_token}" == clw_gjt_* ]] || fail "Group join token create did not return a valid token"

  run_container "${ALPHA_CONTAINER}" "clawdentity --json group join '${join_token}' --agent-name '${ALPHA_AGENT_NAME}'" >/dev/null
  run_container "${BETA_CONTAINER}" "clawdentity --json group join '${join_token}' --agent-name '${BETA_AGENT_NAME}'" >/dev/null
  run_host_json "${clawd_bin}" group join "${join_token}" --agent-name "${HERMES_AGENT_NAME}" >/dev/null

  local group_members members_count
  group_members="$(run_container "${ALPHA_CONTAINER}" "clawdentity --json group members list '${group_id}' --agent-name '${ALPHA_AGENT_NAME}'")"
  members_count="$(printf '%s' "${group_members}" | jq -r '.members | length')"
  [[ "${members_count}" == "3" ]] || fail "Expected 3 group members, found ${members_count}"

  log "Sending group alpha -> {beta, Hermes} message"
  local beta_state_db beta_group_before gamma_group_before group_payload
  beta_state_db="${OPENCLAW_BETA_HOME}/.clawdentity/states/local/clawdentity.sqlite3"
  wait_for_file "${beta_state_db}" "Beta connector state database"
  beta_group_before="$(delivered_count_from_db "${beta_state_db}")"
  gamma_group_before="$(delivered_count_from_db "${HERMES_STATE_DB}")"
  group_payload="$(jq -nc --arg gid "${group_id}" --arg content "${GROUP_MESSAGE}" '{groupId: $gid, payload: {content: $content}}')"
  send_outbound_from_alpha "${group_payload}"
  wait_for_delivered_count_increase "${beta_state_db}" "${beta_group_before}" "Beta group delivery"
  wait_for_delivered_count_increase "${HERMES_STATE_DB}" "${gamma_group_before}" "Hermes group delivery"

  log "Mixed-provider Hermes smoke passed"
  printf 'alpha_container=%s\n' "${ALPHA_CONTAINER}"
  printf 'beta_container=%s\n' "${BETA_CONTAINER}"
  printf 'hermes_container=%s\n' "${HERMES_CONTAINER}"
  printf 'hermes_home=%s\n' "${HERMES_HOME_ROOT}"
  printf 'model_path=%s\n' "${HERMES_MODEL_PATH}"
  printf 'hermes_profile_provider=%s\n' "${HERMES_EFFECTIVE_PROVIDER}"
  printf 'hermes_profile_model=%s\n' "${HERMES_EFFECTIVE_MODEL}"
  if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    printf 'openrouter_key_configured=1\n'
  else
    printf 'openrouter_key_configured=0\n'
  fi
  printf 'hermes_connector_url=http://127.0.0.1:%s\n' "${HERMES_CONNECTOR_PORT}"
  printf 'hermes_webhook_url=http://127.0.0.1:%s/webhooks/clawdentity\n' "${HERMES_WEBHOOK_PORT}"
  printf 'group_id=%s\n' "${group_id}"
  printf 'direct_message=%s\n' "${DIRECT_MESSAGE}"
  printf 'group_message=%s\n' "${GROUP_MESSAGE}"
}

run "$@"
