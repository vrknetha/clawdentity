#!/usr/bin/env sh
set -eu

PROVIDER_ID="nanobot"
CLAWDENTITY_HOME="${CLAWDENTITY_HOME:-/var/lib/clawdentity/nanobot}"
MOCK_REGISTRY_URL="${MOCK_REGISTRY_URL:-http://mock-registry:13370}"
MOCK_PROXY_URL="${MOCK_PROXY_URL:-http://mock-proxy:13371}"
API_KEY="${API_KEY:-pat_nanobot}"
AGENT_NAME="${AGENT_NAME:-nanobot-agent}"
FRAMEWORK="${FRAMEWORK:-nanobot}"
CONNECTOR_PORT="${CONNECTOR_PORT:-19400}"
RUNTIME_PORT="${RUNTIME_PORT:-18794}"
RUNTIME_BASE_URL="${RUNTIME_BASE_URL:-http://127.0.0.1:${RUNTIME_PORT}}"
RUNTIME_HOOK_PATH="${RUNTIME_HOOK_PATH:-/v1/inbound}"
RUNTIME_HOOK_TOKEN="${RUNTIME_HOOK_TOKEN:-nanobot-hook-token}"
PLATFORM_RUN_CMD="${PLATFORM_RUN_CMD:-python3 /opt/platform/mock-platform.py}"

log() {
  printf '[%s] %s\n' "$PROVIDER_ID" "$*"
}

wait_for_dependency() {
  target_url="$1"
  label="$2"
  retries="${3:-120}"
  sleep_seconds="${4:-1}"
  i=0
  while [ "$i" -lt "$retries" ]; do
    if curl -fsS "$target_url" >/dev/null 2>&1; then
      log "dependency healthy: $label"
      return 0
    fi
    i=$((i + 1))
    sleep "$sleep_seconds"
  done
  log "dependency did not become healthy: $label"
  return 1
}

run_clawdentity() {
  clawdentity --home-dir "$CLAWDENTITY_HOME" "$@"
}

start_connector() {
  connector_args="connector start $AGENT_NAME --port $CONNECTOR_PORT --openclaw-base-url $RUNTIME_BASE_URL --openclaw-hook-path $RUNTIME_HOOK_PATH"
  if [ -n "$RUNTIME_HOOK_TOKEN" ]; then
    connector_args="$connector_args --openclaw-hook-token $RUNTIME_HOOK_TOKEN"
  fi

  # shellcheck disable=SC2086
  sh -c "clawdentity --home-dir '$CLAWDENTITY_HOME' $connector_args" >/var/log/connector.log 2>&1 &
  echo "$!" >/var/run/clawdentity-connector.pid
  wait_for_dependency "http://127.0.0.1:${CONNECTOR_PORT}/v1/status" "connector-runtime"
}

mkdir -p "$CLAWDENTITY_HOME" /var/log /var/run

wait_for_dependency "${MOCK_REGISTRY_URL}/health" "mock-registry"
wait_for_dependency "${MOCK_PROXY_URL}/health" "mock-proxy"

log "initializing clawdentity state"
run_clawdentity init --registry-url "$MOCK_REGISTRY_URL"
run_clawdentity config set apiKey "$API_KEY"
run_clawdentity config set proxyUrl "$MOCK_PROXY_URL"
run_clawdentity agent create "$AGENT_NAME" --framework "$FRAMEWORK"

log "starting connector"
start_connector

log "starting platform runtime"
exec sh -c "$PLATFORM_RUN_CMD"
