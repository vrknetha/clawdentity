#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CLAWDENTITY_ENV_FILE="${CLAWDENTITY_ENV_FILE:-$REPO_ROOT/.env}"

load_dotenv() {
  local env_file="$1"
  [[ -f "$env_file" ]] || return 0
  set -a
  set +u
  # shellcheck disable=SC1090
  source "$env_file"
  set -u
  set +a
}

load_dotenv "$CLAWDENTITY_ENV_FILE"

DOCKER_COMPOSE_FILE="${DOCKER_COMPOSE_FILE:-/Users/dev/Workdir/openclaw/docker-compose.dual.yml}"

OPENCLAW_ALPHA_HOME="${OPENCLAW_ALPHA_HOME:-$HOME/.openclaw-alpha}"
OPENCLAW_BETA_HOME="${OPENCLAW_BETA_HOME:-$HOME/.openclaw-beta}"

BASELINE_ALPHA="${BASELINE_ALPHA:-$HOME/.openclaw-baselines/alpha-kimi-preskill}"
BASELINE_BETA="${BASELINE_BETA:-$HOME/.openclaw-baselines/beta-kimi-preskill}"

PRESERVE_ENV="${PRESERVE_ENV:-1}"
WAIT_TIMEOUT_SECONDS="${WAIT_TIMEOUT_SECONDS:-90}"
ALPHA_CONTAINER="${ALPHA_CONTAINER:-clawdbot-agent-alpha-1}"
BETA_CONTAINER="${BETA_CONTAINER:-clawdbot-agent-beta-1}"
DOCKER_REGISTRY_URL="${DOCKER_REGISTRY_URL:-${CLAWDENTITY_REGISTRY_URL:-http://host.docker.internal:8788}}"
DOCKER_PROXY_URL="${DOCKER_PROXY_URL:-${CLAWDENTITY_PROXY_URL:-http://host.docker.internal:8787}}"

log() {
  printf '[openclaw-relay-ready] %s\n' "$*"
}

fail() {
  printf '[openclaw-relay-ready] ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

require_dir() {
  local path="$1"
  [[ -d "$path" ]] || fail "Directory not found: $path"
}

docker_compose_dual() {
  [[ -f "$DOCKER_COMPOSE_FILE" ]] || fail "docker compose file not found: $DOCKER_COMPOSE_FILE"
  docker compose -f "$DOCKER_COMPOSE_FILE" "$@"
}

wait_for_ui() {
  local port="$1"
  local container="$2"
  local waited=0

  while true; do
    if curl -fsS --max-time 2 "http://127.0.0.1:${port}/" >/dev/null 2>&1; then
      log "Port ${port}: UI ready"
      return
    fi
    if docker exec "$container" sh -lc "curl -fsS --max-time 2 http://127.0.0.1:18789/ >/dev/null 2>&1"; then
      log "Port ${port}: UI ready (container-local probe)"
      return
    fi

    waited=$((waited + 1))
    if [[ "$waited" -ge "$WAIT_TIMEOUT_SECONDS" ]]; then
      docker logs --tail 120 "$container" >&2 || true
      fail "Port ${port}: UI readiness timeout (${WAIT_TIMEOUT_SECONDS}s)"
    fi
    sleep 1
  done
}

write_gateway_defaults() {
  node -e '
    const fs = require("fs");
    const crypto = require("crypto");
    const paths = process.argv.slice(1, 3);
    const registryUrl = process.argv[3];
    const proxyUrl = process.argv[4];

    const readEnvFile = (envPath) => (fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "");

    const readEnvToken = (raw) => {
      for (const line of raw.split(/\r?\n/)) {
        const match = line.match(/^\s*OPENCLAW_GATEWAY_TOKEN\s*=\s*(.+)\s*$/);
        if (!match) {
          continue;
        }
        const value = match[1].trim().replace(/^"+|"+$/g, "");
        if (value.length > 0) {
          return value;
        }
      }
      return null;
    };

    const upsertEnvValue = (raw, key, value) => {
      const line = `${key}=${value}`;
      const keyPattern = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
      if (keyPattern.test(raw)) {
        const next = raw.replace(keyPattern, line);
        return next.endsWith("\n") ? next : `${next}\n`;
      }
      if (raw.trim().length === 0) {
        return `${line}\n`;
      }
      return raw.endsWith("\n") ? `${raw}${line}\n` : `${raw}\n${line}\n`;
    };

    for (const configPath of paths) {
      const envPath = configPath.replace(/openclaw\.json$/, ".env");
      const envRaw = readEnvFile(envPath);
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
      cfg.gateway = cfg.gateway || {};
      cfg.gateway.mode = "local";
      cfg.gateway.bind = "lan";
      cfg.gateway.controlUi = {
        ...(cfg.gateway.controlUi || {}),
        allowInsecureAuth: true,
      };
      if (typeof cfg.gateway.auth !== "object" || cfg.gateway.auth === null) {
        cfg.gateway.auth = {};
      }
      const envToken = readEnvToken(envRaw);
      const configToken =
        typeof cfg.gateway.auth.token === "string" && cfg.gateway.auth.token.trim().length > 0
          ? cfg.gateway.auth.token.trim()
          : null;
      const token = envToken || configToken || crypto.randomBytes(24).toString("hex");
      cfg.gateway.auth.token = token;
      fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
      let nextEnvRaw = upsertEnvValue(envRaw, "OPENCLAW_GATEWAY_TOKEN", token);
      nextEnvRaw = upsertEnvValue(nextEnvRaw, "CLAWDENTITY_REGISTRY_URL", registryUrl);
      nextEnvRaw = upsertEnvValue(nextEnvRaw, "CLAWDENTITY_PROXY_URL", proxyUrl);
      fs.writeFileSync(envPath, nextEnvRaw);
    }
  ' \
    "$OPENCLAW_ALPHA_HOME/openclaw.json" \
    "$OPENCLAW_BETA_HOME/openclaw.json" \
    "$DOCKER_REGISTRY_URL" \
    "$DOCKER_PROXY_URL"
}

remove_skill_artifacts() {
  local profile_path="$1"
  rm -rf \
    "$profile_path/skills/clawdentity-openclaw-relay" \
    "$profile_path/workspace/skills/clawdentity-openclaw-relay" \
    "$profile_path/workspace/node_modules/clawdentity"
  rm -f "$profile_path/hooks/transforms/relay-to-peer.mjs"
}

clear_runtime_state() {
  local profile_path="$1"
  rm -f "$profile_path/memory/main.sqlite"
  if [[ -d "$profile_path/agents/main/sessions" ]]; then
    find "$profile_path/agents/main/sessions" -type f -delete
  fi
}

print_urls() {
  node -e '
    const fs = require("fs");
    const alphaHome = process.argv[1];
    const betaHome = process.argv[2];

    const tokenFromEnvFile = (profileHome) => {
      const envPath = `${profileHome}/.env`;
      if (!fs.existsSync(envPath)) return null;
      const raw = fs.readFileSync(envPath, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const match = line.match(/^\s*OPENCLAW_GATEWAY_TOKEN\s*=\s*(.+)\s*$/);
        if (!match) continue;
        const value = match[1].trim().replace(/^"+|"+$/g, "");
        if (value.length > 0) return value;
      }
      return null;
    };

    const tokenFromConfig = (profileHome) => {
      const cfg = JSON.parse(fs.readFileSync(`${profileHome}/openclaw.json`, "utf8"));
      const token = cfg?.gateway?.auth?.token;
      return typeof token === "string" && token.trim().length > 0 ? token.trim() : "";
    };

    const alphaToken = tokenFromEnvFile(alphaHome) || tokenFromConfig(alphaHome);
    const betaToken = tokenFromEnvFile(betaHome) || tokenFromConfig(betaHome);
    console.log(`alpha_url=http://localhost:18789/#token=${alphaToken}`);
    console.log(`beta_url=http://localhost:19001/#token=${betaToken}`);
  ' \
    "$OPENCLAW_ALPHA_HOME" \
    "$OPENCLAW_BETA_HOME"
}

run() {
  require_command docker
  require_command rsync
  require_command node
  require_command curl
  require_dir "$BASELINE_ALPHA"
  require_dir "$BASELINE_BETA"

  local tmp_dir
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "${tmp_dir:-}"' EXIT

  if [[ "$PRESERVE_ENV" == "1" ]]; then
    [[ -f "$OPENCLAW_ALPHA_HOME/.env" ]] || fail "Missing .env: $OPENCLAW_ALPHA_HOME/.env"
    [[ -f "$OPENCLAW_BETA_HOME/.env" ]] || fail "Missing .env: $OPENCLAW_BETA_HOME/.env"
    cp "$OPENCLAW_ALPHA_HOME/.env" "$tmp_dir/alpha.env"
    cp "$OPENCLAW_BETA_HOME/.env" "$tmp_dir/beta.env"
  fi

  log "Stopping dual OpenClaw stack"
  docker_compose_dual down --remove-orphans

  log "Restoring factory baseline profiles"
  rsync -a --delete "$BASELINE_ALPHA/" "$OPENCLAW_ALPHA_HOME/"
  rsync -a --delete "$BASELINE_BETA/" "$OPENCLAW_BETA_HOME/"

  if [[ "$PRESERVE_ENV" == "1" ]]; then
    log "Restoring preserved .env API configuration"
    cp "$tmp_dir/alpha.env" "$OPENCLAW_ALPHA_HOME/.env"
    cp "$tmp_dir/beta.env" "$OPENCLAW_BETA_HOME/.env"
  fi

  log "Applying gateway defaults + clearing runtime state"
  write_gateway_defaults
  clear_runtime_state "$OPENCLAW_ALPHA_HOME"
  clear_runtime_state "$OPENCLAW_BETA_HOME"
  remove_skill_artifacts "$OPENCLAW_ALPHA_HOME"
  remove_skill_artifacts "$OPENCLAW_BETA_HOME"

  log "Starting dual OpenClaw stack"
  docker_compose_dual up -d

  wait_for_ui 18789 "$ALPHA_CONTAINER"
  wait_for_ui 19001 "$BETA_CONTAINER"

  print_urls

  printf 'alpha_sessions=%s\n' "$(find "$OPENCLAW_ALPHA_HOME/agents/main/sessions" -type f 2>/dev/null | wc -l | tr -d ' ')"
  printf 'beta_sessions=%s\n' "$(find "$OPENCLAW_BETA_HOME/agents/main/sessions" -type f 2>/dev/null | wc -l | tr -d ' ')"
  [[ -d "$OPENCLAW_ALPHA_HOME/skills/clawdentity-openclaw-relay" ]] && echo "alpha_skill_present=1" || echo "alpha_skill_present=0"
  [[ -d "$OPENCLAW_BETA_HOME/skills/clawdentity-openclaw-relay" ]] && echo "beta_skill_present=1" || echo "beta_skill_present=0"
  [[ -d "$OPENCLAW_ALPHA_HOME/workspace/node_modules/clawdentity" ]] && echo "alpha_pkg_present=1" || echo "alpha_pkg_present=0"
  [[ -d "$OPENCLAW_BETA_HOME/workspace/node_modules/clawdentity" ]] && echo "beta_pkg_present=1" || echo "beta_pkg_present=0"

  log "Ready state complete"
}

run
