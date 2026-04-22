#!/usr/bin/env bash
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if ! command -v jq >/dev/null 2>&1; then
  echo "missing dependency: jq" >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "missing dependency: curl" >&2
  exit 1
fi

REGISTRY_URL="${MOCK_REGISTRY_URL:-http://127.0.0.1:13370}"
PROXY_URL="${MOCK_PROXY_URL:-http://127.0.0.1:13371}"

CLI_BIN="$ROOT_DIR/target/debug/clawdentity-cli"
REGISTRY_BIN="$ROOT_DIR/target/debug/mock-registry"
PROXY_BIN="$ROOT_DIR/target/debug/mock-proxy"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/clawdentity-local-e2e.XXXXXX")"
HOME_A="$WORK_DIR/home-a"
HOME_B="$WORK_DIR/home-b"
LOG_DIR="$WORK_DIR/logs"
mkdir -p "$HOME_A" "$HOME_B" "$LOG_DIR"

AGENT_A_DID=""
AGENT_B_DID=""
AIT_A=""
AIT_B=""

TOTAL=0
PASSED=0
FAILED=0

cleanup() {
  if [[ -n "${REGISTRY_PID:-}" ]]; then
    kill "${REGISTRY_PID}" 2>/dev/null || true
  fi
  if [[ -n "${PROXY_PID:-}" ]]; then
    kill "${PROXY_PID}" 2>/dev/null || true
  fi
  wait "${REGISTRY_PID:-}" 2>/dev/null || true
  wait "${PROXY_PID:-}" 2>/dev/null || true
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

wait_for_health() {
  local url="$1"
  local max_attempts="${2:-60}"
  local i=0
  while (( i < max_attempts )); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
    i=$((i + 1))
  done
  return 1
}

run_cli() {
  local home_dir="$1"
  shift
  RUST_LOG=error \
  CLAWDENTITY_HOME="$home_dir" \
  CLAWDENTITY_REGISTRY_URL="$REGISTRY_URL" \
  CLAWDENTITY_PROXY_URL="$PROXY_URL" \
  "$CLI_BIN" --home-dir "$home_dir" "$@"
}

run_scenario() {
  local name="$1"
  local fn="$2"
  TOTAL=$((TOTAL + 1))
  echo "== ${name}"
  if (set -euo pipefail; "$fn"); then
    PASSED=$((PASSED + 1))
    echo "PASS: ${name}"
  else
    FAILED=$((FAILED + 1))
    echo "FAIL: ${name}"
  fi
  echo
}

scenario_1_identity_init() {
  run_cli "$HOME_A" init --registry-url "$REGISTRY_URL" >/dev/null
  run_cli "$HOME_B" init --registry-url "$REGISTRY_URL" >/dev/null
}

scenario_2_register_both() {
  local out_a out_b
  out_a="$(run_cli "$HOME_A" --json register --registry-url "$REGISTRY_URL")"
  out_b="$(run_cli "$HOME_B" --json register --registry-url "$REGISTRY_URL")"
  jq -e '.status == "not_supported"' >/dev/null <<<"$out_a"
  jq -e '.status == "not_supported"' >/dev/null <<<"$out_b"
}

scenario_3_config_init_show() {
  run_cli "$HOME_A" config init --registry-url "$REGISTRY_URL" >/dev/null
  run_cli "$HOME_B" config init --registry-url "$REGISTRY_URL" >/dev/null

  run_cli "$HOME_A" config set apiKey pat_local_a >/dev/null
  run_cli "$HOME_B" config set apiKey pat_local_b >/dev/null
  run_cli "$HOME_A" config set proxyUrl "$PROXY_URL" >/dev/null
  run_cli "$HOME_B" config set proxyUrl "$PROXY_URL" >/dev/null

  local show_a show_b
  show_a="$(run_cli "$HOME_A" --json config show)"
  show_b="$(run_cli "$HOME_B" --json config show)"
  jq -e --arg url "$REGISTRY_URL" '.registryUrl | startswith($url)' >/dev/null <<<"$show_a"
  jq -e --arg url "$REGISTRY_URL" '.registryUrl | startswith($url)' >/dev/null <<<"$show_b"
}

scenario_4_agent_create_inspect() {
  local create_a create_b inspect_a inspect_b

  create_a="$(run_cli "$HOME_A" --json agent create alpha --framework generic)"
  create_b="$(run_cli "$HOME_B" --json agent create beta --framework generic)"
  AGENT_A_DID="$(jq -r '.did' <<<"$create_a")"
  AGENT_B_DID="$(jq -r '.did' <<<"$create_b")"
  [[ -n "$AGENT_A_DID" && "$AGENT_A_DID" != "null" ]]
  [[ -n "$AGENT_B_DID" && "$AGENT_B_DID" != "null" ]]

  inspect_a="$(run_cli "$HOME_A" --json agent inspect alpha)"
  inspect_b="$(run_cli "$HOME_B" --json agent inspect beta)"
  jq -e --arg did "$AGENT_A_DID" '.did == $did' >/dev/null <<<"$inspect_a"
  jq -e --arg did "$AGENT_B_DID" '.did == $did' >/dev/null <<<"$inspect_b"

  AIT_A="$(tr -d '\n' < "$HOME_A/.clawdentity/states/local/agents/alpha/ait.jwt")"
  AIT_B="$(tr -d '\n' < "$HOME_B/.clawdentity/states/local/agents/beta/ait.jwt")"
  [[ -n "$AIT_A" && -n "$AIT_B" ]]

  printf '%s\n' "$AGENT_A_DID" > "$WORK_DIR/agent_a_did"
  printf '%s\n' "$AGENT_B_DID" > "$WORK_DIR/agent_b_did"
  printf '%s\n' "$AIT_A" > "$WORK_DIR/ait_a"
  printf '%s\n' "$AIT_B" > "$WORK_DIR/ait_b"
}

scenario_5_pairing_flow() {
  local ts nonce start_payload confirm_payload start_resp confirm_resp status_resp ticket
  AGENT_A_DID="$(tr -d '\n' < "$WORK_DIR/agent_a_did")"
  AGENT_B_DID="$(tr -d '\n' < "$WORK_DIR/agent_b_did")"
  AIT_A="$(tr -d '\n' < "$WORK_DIR/ait_a")"
  AIT_B="$(tr -d '\n' < "$WORK_DIR/ait_b")"

  ts="$(date +%s)"
  nonce="nonce-$(date +%s%N)"

  start_payload="$(jq -nc --arg p "$PROXY_URL" \
    '{ttlSeconds: 300, initiatorProfile: {agentName: "alpha", humanName: "Alice", proxyOrigin: $p}}')"
  start_resp="$(curl -fsS -X POST "$PROXY_URL/pair/start" \
    -H "Authorization: Claw $AIT_A" \
    -H "Content-Type: application/json" \
    -H "X-Claw-Timestamp: $ts" \
    -H "X-Claw-Nonce: $nonce" \
    -H "X-Claw-Body-SHA256: local-e2e" \
    -H "X-Claw-Proof: local-e2e" \
    --data "$start_payload")"
  ticket="$(jq -r '.ticket' <<<"$start_resp")"
  [[ "$ticket" == clwpair1_* ]]

  confirm_payload="$(jq -nc --arg t "$ticket" --arg p "$PROXY_URL" \
    '{ticket: $t, responderProfile: {agentName: "beta", humanName: "Bob", proxyOrigin: $p}}')"
  confirm_resp="$(curl -fsS -X POST "$PROXY_URL/pair/confirm" \
    -H "Authorization: Claw $AIT_B" \
    -H "Content-Type: application/json" \
    -H "X-Claw-Timestamp: $ts" \
    -H "X-Claw-Nonce: $nonce" \
    -H "X-Claw-Body-SHA256: local-e2e" \
    -H "X-Claw-Proof: local-e2e" \
    --data "$confirm_payload")"
  jq -e '.paired == true' >/dev/null <<<"$confirm_resp"

  status_resp="$(curl -fsS "$PROXY_URL/pair/status/$ticket")"
  jq -e '.status == "confirmed"' >/dev/null <<<"$status_resp"
  jq -e --arg did "$AGENT_A_DID" '.initiatorAgentDid == $did' >/dev/null <<<"$status_resp"
  jq -e --arg did "$AGENT_B_DID" '.responderAgentDid == $did' >/dev/null <<<"$status_resp"
}

scenario_6_connector_surface_check() {
  run_cli "$HOME_A" connector --help >/dev/null
  run_cli "$HOME_B" connector --help >/dev/null
}

scenario_7_api_key_lifecycle() {
  local created listed revoked key_id
  created="$(run_cli "$HOME_A" --json api-key create --name e2e-cli)"
  key_id="$(jq -r '.apiKey.id' <<<"$created")"
  [[ -n "$key_id" && "$key_id" != "null" ]]

  listed="$(run_cli "$HOME_A" --json api-key list)"
  jq -e --arg id "$key_id" '[.apiKeys[] | select(.id == $id)] | length == 1' >/dev/null <<<"$listed"

  revoked="$(run_cli "$HOME_A" --json api-key revoke "$key_id")"
  jq -e --arg id "$key_id" '.apiKeyId == $id' >/dev/null <<<"$revoked"
}

scenario_8_invite_create_redeem() {
  local invite created code redeemed
  created="$(run_cli "$HOME_A" --json invite create)"
  code="$(jq -r '.invite.code' <<<"$created")"
  [[ -n "$code" && "$code" != "null" ]]

  redeemed="$(run_cli "$HOME_B" --json invite redeem "$code" --display-name "Bob" --api-key-name "beta-cli")"
  jq -e '.humanName == "Bob"' >/dev/null <<<"$redeemed"
  jq -e '.apiKeyToken | startswith("pat_")' >/dev/null <<<"$redeemed"
  jq -e --arg proxy "$PROXY_URL" '.proxyUrl | startswith($proxy)' >/dev/null <<<"$redeemed"
}

echo "Building binaries..."
cargo build -p mock-registry -p mock-proxy -p clawdentity-cli >/dev/null

echo "Starting mock services..."
MOCK_PROXY_URL="$PROXY_URL" "$PROXY_BIN" >"$LOG_DIR/mock-proxy.log" 2>&1 &
PROXY_PID=$!
MOCK_REGISTRY_URL="$REGISTRY_URL" MOCK_PROXY_URL="$PROXY_URL" "$REGISTRY_BIN" >"$LOG_DIR/mock-registry.log" 2>&1 &
REGISTRY_PID=$!

wait_for_health "$PROXY_URL/health" || { echo "mock-proxy failed to start"; exit 1; }
wait_for_health "$REGISTRY_URL/health" || { echo "mock-registry failed to start"; exit 1; }

run_scenario "Scenario 1: Identity init (both agents)" scenario_1_identity_init
run_scenario "Scenario 2: Register (both agents)" scenario_2_register_both
run_scenario "Scenario 3: Config init + show" scenario_3_config_init_show
run_scenario "Scenario 4: Agent create + inspect" scenario_4_agent_create_inspect
run_scenario "Scenario 5: Pairing (A starts, B confirms, verify peers)" scenario_5_pairing_flow
run_scenario "Scenario 6: Connector command surface check" scenario_6_connector_surface_check
run_scenario "Scenario 7: API key create + list + revoke" scenario_7_api_key_lifecycle
run_scenario "Scenario 8: Invite create + redeem" scenario_8_invite_create_redeem

echo "Summary: ${PASSED}/${TOTAL} passed, ${FAILED} failed"
if (( FAILED > 0 )); then
  echo "Service logs are in: $LOG_DIR" >&2
  exit 1
fi
