#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

CLAWDENTITY_ENV_FILE="${CLAWDENTITY_ENV_FILE:-${REPO_ROOT}/.env}"

HERMES_HOME_ROOT="${HERMES_HOME_ROOT:-/tmp/clawdentity-hermes-home}"
HERMES_HOME_DIR="${HERMES_HOME_ROOT}/.hermes"
HERMES_CONFIG_FILE="${HERMES_HOME_DIR}/config.yaml"
HERMES_ENV_FILE="${HERMES_HOME_DIR}/.env"
HERMES_CODEX_HOME_DIR="${HERMES_HOME_DIR}/.codex"

HERMES_CONTAINER="${HERMES_CONTAINER:-clawdentity-hermes-smoke}"
HERMES_IMAGE="${HERMES_IMAGE:-nousresearch/hermes-agent:latest}"
HERMES_DOCKER_PLATFORM="${HERMES_DOCKER_PLATFORM:-}"
HERMES_WEBHOOK_PORT="${HERMES_WEBHOOK_PORT:-8644}"
HERMES_API_PORT="${HERMES_API_PORT:-8642}"
HERMES_API_HOST="${HERMES_API_HOST:-0.0.0.0}"
HERMES_EXPECTED_AGENT_NAME="${HERMES_EXPECTED_AGENT_NAME:-gamma-hermes}"

HERMES_SEED_HOME="${HERMES_SEED_HOME:-$HOME/.hermes}"
HERMES_SEED_CONFIG_FILE="${HERMES_SEED_CONFIG_FILE:-${HERMES_SEED_HOME}/config.yaml}"
HERMES_SEED_ENV_FILE="${HERMES_SEED_ENV_FILE:-${HERMES_SEED_HOME}/.env}"
HOST_CODEX_AUTH_FILE="${HOST_CODEX_AUTH_FILE:-$HOME/.codex/auth.json}"
HERMES_PROFILE_PROVIDER="${HERMES_PROFILE_PROVIDER:-openrouter}"
HERMES_PROFILE_MODEL="${HERMES_PROFILE_MODEL:-moonshotai/kimi-k2.5}"
HERMES_FALLBACK_PROVIDER="${HERMES_FALLBACK_PROVIDER:-openai-codex}"
HERMES_FALLBACK_MODEL="${HERMES_FALLBACK_MODEL:-gpt-5.4}"
HERMES_API_KEY="${HERMES_API_KEY:-clawdentity-hermes-local-dev}"
HERMES_EFFECTIVE_PROVIDER=""
HERMES_EFFECTIVE_MODEL=""
HERMES_MODEL_PATH=""

OPEN_WEBUI_CONTAINER="${OPEN_WEBUI_CONTAINER:-clawdentity-hermes-open-webui}"
OPEN_WEBUI_IMAGE="${OPEN_WEBUI_IMAGE:-ghcr.io/open-webui/open-webui:main}"
OPEN_WEBUI_PORT="${OPEN_WEBUI_PORT:-3000}"
OPEN_WEBUI_VOLUME="${OPEN_WEBUI_VOLUME:-clawdentity-hermes-open-webui}"

CLAWDENTITY_SITE_BASE_URL="${CLAWDENTITY_SITE_BASE_URL:-http://localhost:4321}"
DOCKER_SITE_BASE_URL="${DOCKER_SITE_BASE_URL:-http://host.docker.internal:4321}"
DOCKER_REGISTRY_URL="${DOCKER_REGISTRY_URL:-http://host.docker.internal:8788}"
DOCKER_PROXY_URL="${DOCKER_PROXY_URL:-http://host.docker.internal:8787}"
HOST_REGISTRY_URL="${HOST_REGISTRY_URL:-${CLAWDENTITY_REGISTRY_URL:-http://127.0.0.1:8788}}"
HOST_PROXY_URL="${HOST_PROXY_URL:-${CLAWDENTITY_PROXY_URL:-http://127.0.0.1:8787}}"

RESET_HERMES_HOME="${RESET_HERMES_HOME:-0}"
RESET_OPEN_WEBUI_DATA="${RESET_OPEN_WEBUI_DATA:-0}"
WAIT_ATTEMPTS="${WAIT_ATTEMPTS:-60}"
WAIT_SLEEP_SECONDS="${WAIT_SLEEP_SECONDS:-2}"

if [[ -z "${HERMES_DOCKER_PLATFORM}" ]]; then
  case "$(uname -m)" in
    arm64 | aarch64) HERMES_DOCKER_PLATFORM="linux/amd64" ;;
    *) HERMES_DOCKER_PLATFORM="" ;;
  esac
fi

log() {
  printf '[hermes-webui-ready] %s\n' "$*"
}

fail() {
  printf '[hermes-webui-ready] ERROR: %s\n' "$*" >&2
  exit 1
}

resolve_hermes_model_profile() {
  if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    HERMES_MODEL_PATH="openrouter"
    HERMES_EFFECTIVE_PROVIDER="$HERMES_PROFILE_PROVIDER"
    HERMES_EFFECTIVE_MODEL="$HERMES_PROFILE_MODEL"
    log "Using OpenRouter model profile ${HERMES_EFFECTIVE_PROVIDER}:${HERMES_EFFECTIVE_MODEL}"
    return 0
  fi

  HERMES_MODEL_PATH="codex"
  HERMES_EFFECTIVE_PROVIDER="$HERMES_FALLBACK_PROVIDER"
  HERMES_EFFECTIVE_MODEL="$HERMES_FALLBACK_MODEL"
  log "OPENROUTER_API_KEY not set; using Codex fallback ${HERMES_EFFECTIVE_PROVIDER}:${HERMES_EFFECTIVE_MODEL}"
}

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

seed_or_initialize_profile_file() {
  local seed_file="$1"
  local target_file="$2"
  local init_content="$3"

  if [[ -f "${target_file}" ]]; then
    return 0
  fi

  if [[ -f "${seed_file}" ]]; then
    cp "${seed_file}" "${target_file}"
    return 0
  fi

  printf '%s\n' "${init_content}" >"${target_file}"
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

docker_host_gateway_args() {
  case "$(uname -s)" in
    Linux) printf '%s\n' "--add-host host.docker.internal:host-gateway" ;;
    *) printf '%s\n' "" ;;
  esac
}

prepare_hermes_home() {
  if [[ "${HERMES_MODEL_PATH}" == "codex" ]]; then
    require_file "${HOST_CODEX_AUTH_FILE}"
  fi

  if [[ "${RESET_HERMES_HOME}" == "1" ]]; then
    rm -rf "${HERMES_HOME_ROOT}"
  fi

  mkdir -p "${HERMES_HOME_DIR}" "${HERMES_CODEX_HOME_DIR}" "${HERMES_HOME_ROOT}/logs"

  seed_or_initialize_profile_file "${HERMES_SEED_CONFIG_FILE}" "${HERMES_CONFIG_FILE}" "# isolated Hermes profile for local WebUI testing"
  seed_or_initialize_profile_file "${HERMES_SEED_ENV_FILE}" "${HERMES_ENV_FILE}" "# isolated Hermes env for local WebUI testing"

  if [[ -f "${HOST_CODEX_AUTH_FILE}" ]]; then
    cp "${HOST_CODEX_AUTH_FILE}" "${HERMES_CODEX_HOME_DIR}/auth.json"
  fi

  upsert_env_value "${HERMES_ENV_FILE}" "API_SERVER_ENABLED" "true"
  upsert_env_value "${HERMES_ENV_FILE}" "API_SERVER_KEY" "${HERMES_API_KEY}"
  upsert_env_value "${HERMES_ENV_FILE}" "API_SERVER_HOST" "${HERMES_API_HOST}"
  upsert_env_value "${HERMES_ENV_FILE}" "API_SERVER_PORT" "${HERMES_API_PORT}"
  upsert_env_value "${HERMES_ENV_FILE}" "CLAWDENTITY_REGISTRY_URL" "${DOCKER_REGISTRY_URL}"
  upsert_env_value "${HERMES_ENV_FILE}" "CLAWDENTITY_PROXY_URL" "${DOCKER_PROXY_URL}"
  upsert_env_value "${HERMES_ENV_FILE}" "CLAWDENTITY_SITE_BASE_URL" "${DOCKER_SITE_BASE_URL}"
  upsert_env_value "${HERMES_ENV_FILE}" "CLAWDENTITY_EXPECTED_AGENT_NAME" "${HERMES_EXPECTED_AGENT_NAME}"
  if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    upsert_env_value "${HERMES_ENV_FILE}" "OPENROUTER_API_KEY" "${OPENROUTER_API_KEY}"
  fi

  log "Prepared isolated Hermes profile at ${HERMES_HOME_DIR}"
}

start_hermes_container() {
  local extra_host_arg
  local -a platform_args

  extra_host_arg="$(docker_host_gateway_args)"
  platform_args=()
  if [[ -n "${HERMES_DOCKER_PLATFORM}" ]]; then
    platform_args+=(--platform "${HERMES_DOCKER_PLATFORM}")
  fi

  docker rm -f "${HERMES_CONTAINER}" >/dev/null 2>&1 || true

  if [[ -n "${extra_host_arg}" ]]; then
    docker run -d \
      --name "${HERMES_CONTAINER}" \
      ${extra_host_arg} \
      "${platform_args[@]}" \
      -e CODEX_HOME=/opt/data/.codex \
      -p "${HERMES_WEBHOOK_PORT}:${HERMES_WEBHOOK_PORT}" \
      -p "${HERMES_API_PORT}:${HERMES_API_PORT}" \
      -v "${HERMES_HOME_DIR}:/opt/data" \
      "${HERMES_IMAGE}" \
      gateway run >/dev/null
  else
    docker run -d \
      --name "${HERMES_CONTAINER}" \
      "${platform_args[@]}" \
      -e CODEX_HOME=/opt/data/.codex \
      -p "${HERMES_WEBHOOK_PORT}:${HERMES_WEBHOOK_PORT}" \
      -p "${HERMES_API_PORT}:${HERMES_API_PORT}" \
      -v "${HERMES_HOME_DIR}:/opt/data" \
      "${HERMES_IMAGE}" \
      gateway run >/dev/null
  fi

  log "Started Hermes container ${HERMES_CONTAINER}"
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

configure_hermes_profile_model() {
  docker exec "${HERMES_CONTAINER}" hermes config set model.provider "${HERMES_EFFECTIVE_PROVIDER}" >/dev/null
  docker exec "${HERMES_CONTAINER}" hermes config set model.default "${HERMES_EFFECTIVE_MODEL}" >/dev/null
  log "Configured Hermes model profile ${HERMES_EFFECTIVE_PROVIDER}:${HERMES_EFFECTIVE_MODEL}"
}

start_open_webui_container() {
  local extra_host_arg
  extra_host_arg="$(docker_host_gateway_args)"

  docker rm -f "${OPEN_WEBUI_CONTAINER}" >/dev/null 2>&1 || true

  if [[ "${RESET_OPEN_WEBUI_DATA}" == "1" ]]; then
    docker volume rm "${OPEN_WEBUI_VOLUME}" >/dev/null 2>&1 || true
  fi

  if [[ -n "${extra_host_arg}" ]]; then
    docker run -d \
      --name "${OPEN_WEBUI_CONTAINER}" \
      ${extra_host_arg} \
      -p "${OPEN_WEBUI_PORT}:8080" \
      -e OPENAI_API_BASE_URL="http://host.docker.internal:${HERMES_API_PORT}/v1" \
      -e OPENAI_API_KEY="${HERMES_API_KEY}" \
      -v "${OPEN_WEBUI_VOLUME}:/app/backend/data" \
      --restart unless-stopped \
      "${OPEN_WEBUI_IMAGE}" >/dev/null
  else
    docker run -d \
      --name "${OPEN_WEBUI_CONTAINER}" \
      -p "${OPEN_WEBUI_PORT}:8080" \
      -e OPENAI_API_BASE_URL="http://host.docker.internal:${HERMES_API_PORT}/v1" \
      -e OPENAI_API_KEY="${HERMES_API_KEY}" \
      -v "${OPEN_WEBUI_VOLUME}:/app/backend/data" \
      --restart unless-stopped \
      "${OPEN_WEBUI_IMAGE}" >/dev/null
  fi

  wait_for_http_ok "http://127.0.0.1:${OPEN_WEBUI_PORT}" "Open WebUI"
}

print_summary() {
  printf '\n'
  printf 'hermes_container=%s\n' "${HERMES_CONTAINER}"
  printf 'open_webui_container=%s\n' "${OPEN_WEBUI_CONTAINER}"
  printf 'hermes_home=%s\n' "${HERMES_HOME_ROOT}"
  printf 'hermes_api_url=http://127.0.0.1:%s/v1\n' "${HERMES_API_PORT}"
  printf 'hermes_webhook_url=http://127.0.0.1:%s/webhooks/clawdentity\n' "${HERMES_WEBHOOK_PORT}"
  printf 'open_webui_url=http://127.0.0.1:%s\n' "${OPEN_WEBUI_PORT}"
  printf 'registry_url=%s\n' "${HOST_REGISTRY_URL}"
  printf 'proxy_url=%s\n' "${HOST_PROXY_URL}"
  printf 'docker_registry_url=%s\n' "${DOCKER_REGISTRY_URL}"
  printf 'docker_proxy_url=%s\n' "${DOCKER_PROXY_URL}"
  printf 'docker_site_base_url=%s\n' "${DOCKER_SITE_BASE_URL}"
  printf 'expected_agent_name=%s\n' "${HERMES_EXPECTED_AGENT_NAME}"
  printf 'model_path=%s\n' "${HERMES_MODEL_PATH}"
  printf 'model_provider=%s\n' "${HERMES_EFFECTIVE_PROVIDER}"
  printf 'model_default=%s\n' "${HERMES_EFFECTIVE_MODEL}"
  if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    printf 'openrouter_key_configured=1\n'
  else
    printf 'openrouter_key_configured=0\n'
  fi
  printf '\n'
  printf 'Open Hermes CLI chat:\n'
  printf '  docker exec -it %s hermes\n' "${HERMES_CONTAINER}"
  printf '\n'
  printf 'Open browser UI:\n'
  printf '  http://127.0.0.1:%s\n' "${OPEN_WEBUI_PORT}"
  printf '\n'
}

run() {
  load_dotenv "${CLAWDENTITY_ENV_FILE}"
  resolve_hermes_model_profile

  require_command docker
  require_command curl
  if [[ "${HERMES_MODEL_PATH}" == "codex" && ! -f "${HOST_CODEX_AUTH_FILE}" ]]; then
    fail "OPENROUTER_API_KEY is not set and Codex fallback auth file is missing: ${HOST_CODEX_AUTH_FILE}"
  fi

  prepare_hermes_home
  start_hermes_container
  wait_for_http_ok "http://127.0.0.1:${HERMES_API_PORT}/health" "Hermes API server"
  configure_hermes_profile_model
  start_open_webui_container
  print_summary
}

run "$@"
