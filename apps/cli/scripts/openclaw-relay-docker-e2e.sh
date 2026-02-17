#!/usr/bin/env bash

set -euo pipefail

ALPHA_CONTAINER="${ALPHA_CONTAINER:-clawdbot-agent-alpha-1}"
BETA_CONTAINER="${BETA_CONTAINER:-clawdbot-agent-beta-1}"

ALPHA_AGENT_NAME="${ALPHA_AGENT_NAME:-alpha}"
BETA_AGENT_NAME="${BETA_AGENT_NAME:-beta}"

REGISTRY_URL="${REGISTRY_URL:-http://host.docker.internal:8787}"
PROXY_HOOK_URL="${PROXY_HOOK_URL:-http://host.docker.internal:8788/hooks/agent}"
PROXY_WS_URL="${PROXY_WS_URL:-ws://host.docker.internal:8788/v1/relay/connect}"

ALPHA_HOST_OPENCLAW_URL="${ALPHA_HOST_OPENCLAW_URL:-http://127.0.0.1:18789}"
BETA_HOST_OPENCLAW_URL="${BETA_HOST_OPENCLAW_URL:-http://127.0.0.1:19001}"
CONTAINER_OPENCLAW_BASE_URL="${CONTAINER_OPENCLAW_BASE_URL:-http://127.0.0.1:18789}"

ALPHA_HOOK_TOKEN="${ALPHA_HOOK_TOKEN:-alpha-hook-secret}"
BETA_HOOK_TOKEN="${BETA_HOOK_TOKEN:-beta-hook-secret}"
BOOTSTRAP_SECRET="${BOOTSTRAP_SECRET:-clawdentity-local-bootstrap}"
CLI_GLOBAL_PACKAGE_ROOT="${CLI_GLOBAL_PACKAGE_ROOT:-/home/node/.local/lib/node_modules/clawdentity}"

RESET_MODE="${RESET_MODE:-skill}"
CLAWDENTITY_E2E_PAT="${CLAWDENTITY_E2E_PAT:-}"

log() {
  printf '[openclaw-relay-e2e] %s\n' "$*"
}

fail() {
  printf '[openclaw-relay-e2e] ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

require_running_container() {
  local container="$1"
  local running
  running="$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || true)"
  [[ "$running" == "true" ]] || fail "Container is not running: $container"
}

container_exec() {
  local container="$1"
  shift
  docker exec "$container" sh -lc "$*"
}

container_has_file() {
  local container="$1"
  local file_path="$2"
  container_exec "$container" "test -f $file_path"
}

extract_invite_code() {
  printf '%s\n' "$1" | sed -n 's/^Invite code: //p' | head -n 1
}

extract_pat() {
  printf '%s\n' "$1" | grep -Eo 'clw_pat_[A-Za-z0-9_-]+' | head -n 1
}

read_config_pat() {
  local container="$1"
  container_exec "$container" "node -e 'const fs=require(\"fs\");const p=process.env.HOME+\"/.clawdentity/config.json\";if(!fs.existsSync(p)){process.exit(0);}const cfg=JSON.parse(fs.readFileSync(p,\"utf8\"));if(typeof cfg.apiKey===\"string\"&&cfg.apiKey.trim().length>0){process.stdout.write(cfg.apiKey.trim());}'"
}

read_agent_did() {
  local container="$1"
  local agent_name="$2"
  container_exec "$container" "node -e 'const fs=require(\"fs\");const p=process.env.HOME+\"/.clawdentity/agents/$agent_name/identity.json\";const id=JSON.parse(fs.readFileSync(p,\"utf8\"));process.stdout.write(id.did);'"
}

reset_skill_state() {
  local container="$1"
  local agent_name="$2"

  container_exec "$container" "rm -f ~/.clawdentity/peers.json ~/.clawdentity/openclaw-agent-name ~/.clawdentity/openclaw-relay.json ~/.openclaw/hooks/transforms/relay-to-peer.mjs"
  container_exec "$container" "rm -rf ~/.openclaw/workspace/skills/clawdentity-openclaw-relay"

  if [[ "$RESET_MODE" == "full" ]]; then
    container_exec "$container" "rm -rf ~/.clawdentity/agents/$agent_name"
  fi
}

install_skill_assets() {
  local container="$1"
  local package_root="$CLI_GLOBAL_PACKAGE_ROOT"
  local legacy_package_root="/home/node/.local/lib/node_modules/@clawdentity/cli"

  if ! container_exec "$container" "test -f \"$package_root/postinstall.mjs\""; then
    if container_exec "$container" "test -f \"$legacy_package_root/postinstall.mjs\""; then
      package_root="$legacy_package_root"
    else
      fail "postinstall.mjs not found in CLI package root: $package_root"
    fi
  fi

  container_exec "$container" "npm_config_skill=true node \"$package_root/postinstall.mjs\" >/dev/null"
}

ensure_agent_identity() {
  local container="$1"
  local agent_name="$2"
  if container_exec "$container" "clawdentity agent inspect \"$agent_name\" >/dev/null 2>&1"; then
    log "$container: agent '$agent_name' already exists"
    return
  fi

  log "$container: creating agent '$agent_name'"
  container_exec "$container" "clawdentity agent create \"$agent_name\" --framework openclaw >/dev/null"
}

configure_registry() {
  local container="$1"
  local pat="$2"
  container_exec "$container" "clawdentity config init >/dev/null"
  container_exec "$container" "clawdentity config set registryUrl \"$REGISTRY_URL\" >/dev/null"
  container_exec "$container" "clawdentity config set apiKey \"$pat\" >/dev/null"
}

stop_connector() {
  local container="$1"
  local agent_name="$2"

  container_exec "$container" "if [ -f /tmp/clawdentity-connector-$agent_name.pid ]; then kill \$(cat /tmp/clawdentity-connector-$agent_name.pid) 2>/dev/null || true; fi"
  container_exec "$container" "for pid in \$(ps -ef | awk '/clawdentity connector start $agent_name/ && !/awk/ {print \$2}'); do kill \"\$pid\" 2>/dev/null || true; done"
}

start_connector() {
  local container="$1"
  local agent_name="$2"
  local hook_token="$3"
  local agent_did="$4"

  stop_connector "$container" "$agent_name"
  container_exec "$container" "nohup clawdentity connector start \"$agent_name\" --proxy-ws-url \"$PROXY_WS_URL\" --openclaw-hook-token \"$hook_token\" >/tmp/clawdentity-connector-$agent_name.log 2>&1 & echo \$! > /tmp/clawdentity-connector-$agent_name.pid"

  local waited=0
  while true; do
    if container_exec "$container" "grep -q 'connector.websocket.connected' /tmp/clawdentity-connector-$agent_name.log"; then
      log "$container: connector '$agent_name' connected"
      break
    fi

    waited=$((waited + 1))
    if [[ $waited -ge 30 ]]; then
      container_exec "$container" "tail -n 120 /tmp/clawdentity-connector-$agent_name.log" || true
      fail "$container: connector '$agent_name' did not connect within timeout. Ensure proxy allowlist includes DID $agent_did"
    fi
    sleep 1
  done
}

send_peer_message() {
  local sender_url="$1"
  local hook_token="$2"
  local peer_alias="$3"
  local session_id="$4"
  local message="$5"
  local expected_status="$6"

  local response_body
  response_body="$(mktemp)"
  local status
  status="$(
    curl -sS \
      -o "$response_body" \
      -w '%{http_code}' \
      -X POST "$sender_url/hooks/send-to-peer" \
      -H 'content-type: application/json' \
      -H "x-openclaw-token: $hook_token" \
      --data "{\"peer\":\"$peer_alias\",\"sessionId\":\"$session_id\",\"message\":\"$message\"}"
  )"

  if [[ "$status" != "$expected_status" ]]; then
    log "send-to-peer failed: expected $expected_status, got $status"
    cat "$response_body" >&2
    rm -f "$response_body"
    fail "Unexpected send-to-peer status"
  fi

  log "send-to-peer ok: $sender_url -> $peer_alias ($status) | $message"
  rm -f "$response_body"
}

run() {
  require_command docker
  require_command curl
  require_command node

  require_running_container "$ALPHA_CONTAINER"
  require_running_container "$BETA_CONTAINER"

  log "Validating clawdentity CLI availability in containers"
  container_exec "$ALPHA_CONTAINER" "clawdentity --help >/dev/null" || fail "$ALPHA_CONTAINER missing clawdentity CLI"
  container_exec "$BETA_CONTAINER" "clawdentity --help >/dev/null" || fail "$BETA_CONTAINER missing clawdentity CLI"

  if [[ "$RESET_MODE" != "none" ]]; then
    log "Reset mode: $RESET_MODE"
    reset_skill_state "$ALPHA_CONTAINER" "$ALPHA_AGENT_NAME"
    reset_skill_state "$BETA_CONTAINER" "$BETA_AGENT_NAME"
  fi

  log "Installing skill artifacts via npm --skill postinstall flow"
  install_skill_assets "$ALPHA_CONTAINER"
  install_skill_assets "$BETA_CONTAINER"

  local pat="$CLAWDENTITY_E2E_PAT"
  if [[ -z "$pat" ]]; then
    pat="$(read_config_pat "$ALPHA_CONTAINER")"
  fi

  if [[ -z "$pat" ]]; then
    log "No CLAWDENTITY_E2E_PAT provided; attempting bootstrap on $ALPHA_CONTAINER"
    local bootstrap_output
    if ! bootstrap_output="$(container_exec "$ALPHA_CONTAINER" "clawdentity admin bootstrap --bootstrap-secret \"$BOOTSTRAP_SECRET\"" 2>&1)"; then
      printf '%s\n' "$bootstrap_output" >&2
      fail "Bootstrap failed. Set CLAWDENTITY_E2E_PAT for pre-bootstrapped environments."
    fi

    pat="$(extract_pat "$bootstrap_output")"
    [[ -n "$pat" ]] || fail "Failed to extract PAT from bootstrap output"
  fi
  log "Using PAT for CLI config in both containers"

  configure_registry "$ALPHA_CONTAINER" "$pat"
  configure_registry "$BETA_CONTAINER" "$pat"

  ensure_agent_identity "$ALPHA_CONTAINER" "$ALPHA_AGENT_NAME"
  ensure_agent_identity "$BETA_CONTAINER" "$BETA_AGENT_NAME"

  local alpha_did beta_did
  alpha_did="$(read_agent_did "$ALPHA_CONTAINER" "$ALPHA_AGENT_NAME")"
  beta_did="$(read_agent_did "$BETA_CONTAINER" "$BETA_AGENT_NAME")"
  log "Alpha DID: $alpha_did"
  log "Beta DID:  $beta_did"

  log "Creating invite code in $BETA_CONTAINER for peer alias '$BETA_AGENT_NAME'"
  local beta_invite_output beta_invite_code
  beta_invite_output="$(
    container_exec "$BETA_CONTAINER" \
      "clawdentity openclaw invite --did \"$beta_did\" --proxy-url \"$PROXY_HOOK_URL\" --peer-alias \"$BETA_AGENT_NAME\""
  )"
  beta_invite_code="$(extract_invite_code "$beta_invite_output")"
  [[ -n "$beta_invite_code" ]] || fail "Failed to extract beta invite code"

  log "Creating invite code in $ALPHA_CONTAINER for peer alias '$ALPHA_AGENT_NAME'"
  local alpha_invite_output alpha_invite_code
  alpha_invite_output="$(
    container_exec "$ALPHA_CONTAINER" \
      "clawdentity openclaw invite --did \"$alpha_did\" --proxy-url \"$PROXY_HOOK_URL\" --peer-alias \"$ALPHA_AGENT_NAME\""
  )"
  alpha_invite_code="$(extract_invite_code "$alpha_invite_output")"
  [[ -n "$alpha_invite_code" ]] || fail "Failed to extract alpha invite code"

  log "Running invite onboarding setup inside $ALPHA_CONTAINER"
  container_exec "$ALPHA_CONTAINER" \
    "clawdentity openclaw setup \"$ALPHA_AGENT_NAME\" --invite-code \"$beta_invite_code\" --openclaw-base-url \"$CONTAINER_OPENCLAW_BASE_URL\" >/dev/null"

  log "Running invite onboarding setup inside $BETA_CONTAINER"
  container_exec "$BETA_CONTAINER" \
    "clawdentity openclaw setup \"$BETA_AGENT_NAME\" --invite-code \"$alpha_invite_code\" --openclaw-base-url \"$CONTAINER_OPENCLAW_BASE_URL\" >/dev/null"

  log "Verifying skill-created artifacts"
  container_has_file "$ALPHA_CONTAINER" '$HOME/.clawdentity/peers.json' || fail "Alpha peers.json missing"
  container_has_file "$ALPHA_CONTAINER" '$HOME/.clawdentity/openclaw-agent-name' || fail "Alpha openclaw-agent-name missing"
  container_has_file "$ALPHA_CONTAINER" '$HOME/.clawdentity/openclaw-relay.json' || fail "Alpha openclaw-relay.json missing"
  container_has_file "$ALPHA_CONTAINER" '$HOME/.openclaw/hooks/transforms/relay-to-peer.mjs' || fail "Alpha relay transform missing"
  container_has_file "$ALPHA_CONTAINER" '$HOME/.openclaw/workspace/skills/clawdentity-openclaw-relay/SKILL.md' || fail "Alpha skill bundle missing"
  container_has_file "$BETA_CONTAINER" '$HOME/.clawdentity/peers.json' || fail "Beta peers.json missing"
  container_has_file "$BETA_CONTAINER" '$HOME/.clawdentity/openclaw-agent-name' || fail "Beta openclaw-agent-name missing"
  container_has_file "$BETA_CONTAINER" '$HOME/.clawdentity/openclaw-relay.json' || fail "Beta openclaw-relay.json missing"
  container_has_file "$BETA_CONTAINER" '$HOME/.openclaw/hooks/transforms/relay-to-peer.mjs' || fail "Beta relay transform missing"
  container_has_file "$BETA_CONTAINER" '$HOME/.openclaw/workspace/skills/clawdentity-openclaw-relay/SKILL.md' || fail "Beta skill bundle missing"

  log "Starting connector runtimes"
  start_connector "$ALPHA_CONTAINER" "$ALPHA_AGENT_NAME" "$ALPHA_HOOK_TOKEN" "$alpha_did"
  start_connector "$BETA_CONTAINER" "$BETA_AGENT_NAME" "$BETA_HOOK_TOKEN" "$beta_did"

  log "Running bidirectional multi-message relay"
  send_peer_message "$ALPHA_HOST_OPENCLAW_URL" "$ALPHA_HOOK_TOKEN" "$BETA_AGENT_NAME" "relay-alpha-beta" "alpha to beta m1" "204"
  send_peer_message "$ALPHA_HOST_OPENCLAW_URL" "$ALPHA_HOOK_TOKEN" "$BETA_AGENT_NAME" "relay-alpha-beta" "alpha to beta m2" "204"
  send_peer_message "$ALPHA_HOST_OPENCLAW_URL" "$ALPHA_HOOK_TOKEN" "$BETA_AGENT_NAME" "relay-alpha-beta" "alpha to beta m3" "204"
  send_peer_message "$BETA_HOST_OPENCLAW_URL" "$BETA_HOOK_TOKEN" "$ALPHA_AGENT_NAME" "relay-beta-alpha" "beta to alpha m1" "204"
  send_peer_message "$BETA_HOST_OPENCLAW_URL" "$BETA_HOOK_TOKEN" "$ALPHA_AGENT_NAME" "relay-beta-alpha" "beta to alpha m2" "204"

  log "Running edge case: unknown peer alias"
  send_peer_message "$ALPHA_HOST_OPENCLAW_URL" "$ALPHA_HOOK_TOKEN" "unknown-peer" "relay-alpha-invalid-peer" "should fail with unknown peer alias" "500"

  log "Running edge case: connector offline and recovery"
  stop_connector "$BETA_CONTAINER" "$BETA_AGENT_NAME"
  send_peer_message "$ALPHA_HOST_OPENCLAW_URL" "$ALPHA_HOOK_TOKEN" "$BETA_AGENT_NAME" "relay-alpha-beta-offline" "should fail while beta connector is offline" "500"
  start_connector "$BETA_CONTAINER" "$BETA_AGENT_NAME" "$BETA_HOOK_TOKEN" "$beta_did"
  send_peer_message "$ALPHA_HOST_OPENCLAW_URL" "$ALPHA_HOOK_TOKEN" "$BETA_AGENT_NAME" "relay-alpha-beta-recovered" "should succeed after beta connector reconnect" "204"

  log "E2E complete: invite onboarding + skill artifacts + bidirectional relay + edge cases"
}

run
