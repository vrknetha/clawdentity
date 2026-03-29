#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLAWDENTITY_ENV_FILE="${CLAWDENTITY_ENV_FILE:-$REPO_ROOT/.env}"
LOCAL_PROFILE_DIR="${LOCAL_PROFILE_DIR:-$SCRIPT_DIR/openclaw-local-profile}"
LOCAL_OPENCLAW_POLICY_FILE="${LOCAL_OPENCLAW_POLICY_FILE:-$LOCAL_PROFILE_DIR/openclaw.json}"
LOCAL_EXEC_APPROVALS_FILE="${LOCAL_EXEC_APPROVALS_FILE:-$LOCAL_PROFILE_DIR/exec-approvals.json}"
HOST_CODEX_AUTH_FILE="${HOST_CODEX_AUTH_FILE:-$HOME/.codex/auth.json}"
LOCAL_OPENCLAW_MODEL="${LOCAL_OPENCLAW_MODEL:-openai-codex/gpt-5.4}"

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
DEVICE_AUTO_APPROVE_SECONDS="${DEVICE_AUTO_APPROVE_SECONDS:-180}"
ALPHA_CONTAINER="${ALPHA_CONTAINER:-clawdbot-agent-alpha-1}"
BETA_CONTAINER="${BETA_CONTAINER:-clawdbot-agent-beta-1}"
ALPHA_UI_PORT="${ALPHA_UI_PORT:-18789}"
BETA_UI_PORT="${BETA_UI_PORT:-19001}"
ALPHA_EXPECTED_AGENT_NAME="${ALPHA_EXPECTED_AGENT_NAME:-alpha-local}"
BETA_EXPECTED_AGENT_NAME="${BETA_EXPECTED_AGENT_NAME:-beta-local}"
DOCKER_REGISTRY_URL="${DOCKER_REGISTRY_URL:-${CLAWDENTITY_REGISTRY_URL:-http://host.docker.internal:8788}}"
DOCKER_PROXY_URL="${DOCKER_PROXY_URL:-${CLAWDENTITY_PROXY_URL:-http://host.docker.internal:8787}}"
CLAWDENTITY_SITE_BASE_URL="${CLAWDENTITY_SITE_BASE_URL:-http://localhost:4321}"
DOCKER_SITE_BASE_URL="${DOCKER_SITE_BASE_URL:-http://host.docker.internal:4321}"
HOST_REGISTRY_URL="${HOST_REGISTRY_URL:-http://127.0.0.1:8788}"
HOST_PROXY_URL="${HOST_PROXY_URL:-http://127.0.0.1:8787}"
HOST_SITE_BASE_URL="${HOST_SITE_BASE_URL:-$CLAWDENTITY_SITE_BASE_URL}"
VERIFY_STACK_DEPENDENCIES="${VERIFY_STACK_DEPENDENCIES:-1}"
CLAWDENTITY_RELEASE_MANIFEST_URL="${CLAWDENTITY_RELEASE_MANIFEST_URL:-https://downloads.clawdentity.com/rust/latest.json}"
CLAWDENTITY_INSTALL_DIR_IN_CONTAINER="${CLAWDENTITY_INSTALL_DIR_IN_CONTAINER:-/home/node/.local/bin}"
CLAWDENTITY_CLI_PATH_IN_CONTAINER="${CLAWDENTITY_CLI_PATH_IN_CONTAINER:-/home/node/.local/bin/clawdentity}"
BUILD_CLI_BEFORE_TEST="${BUILD_CLI_BEFORE_TEST:-1}"
CLAWDENTITY_LATEST_VERSION=""

log() {
  printf '[openclaw-relay-ready] %s\n' "$*"
}

fail() {
  printf '[openclaw-relay-ready] ERROR: %s\n' "$*" >&2
  exit 1
}

copy_preserved_env_values() {
  local source_env="$1"
  local target_env="$2"

  node -e '
    const fs = require("fs");
    const sourcePath = process.argv[1];
    const targetPath = process.argv[2];
    const preservedKeys = new Set([
      "KIMI_API_KEY",
      "KIMICODE_API_KEY",
      "OPENAI_API_KEY",
      "OPENCLAW_GATEWAY_TOKEN",
    ]);

    const parseEnv = (raw) => {
      const lines = raw.split(/\r?\n/);
      const entries = [];
      for (const line of lines) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
        if (!match) {
          continue;
        }
        entries.push([match[1], match[2]]);
      }
      return entries;
    };

    const upsertEnv = (raw, key, value) => {
      const replacement = `${key}=${value}`;
      const keyPattern = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
      if (keyPattern.test(raw)) {
        const next = raw.replace(keyPattern, replacement);
        return next.endsWith("\n") ? next : `${next}\n`;
      }
      if (raw.trim().length === 0) {
        return `${replacement}\n`;
      }
      return raw.endsWith("\n") ? `${raw}${replacement}\n` : `${raw}\n${replacement}\n`;
    };

    const sourceRaw = fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath, "utf8") : "";
    let targetRaw = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : "";

    for (const [key, value] of parseEnv(sourceRaw)) {
      if (!preservedKeys.has(key)) {
        continue;
      }
      targetRaw = upsertEnv(targetRaw, key, value);
    }

    fs.writeFileSync(targetPath, targetRaw);
  ' "$source_env" "$target_env"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

require_dir() {
  local path="$1"
  [[ -d "$path" ]] || fail "Directory not found: $path"
}

require_file() {
  local path="$1"
  [[ -f "$path" ]] || fail "File not found: $path"
}

read_env_value() {
  local env_file="$1"
  local key="$2"

  [[ -f "$env_file" ]] || return 0
  awk -F= -v search="$key" '
    $0 ~ /^[[:space:]]*#/ { next }
    $1 == search { value = substr($0, index($0, "=") + 1) }
    END { if (value != "") print value }
  ' "$env_file"
}

assert_env_value() {
  local env_file="$1"
  local key="$2"
  local expected="$3"
  local actual
  actual="$(read_env_value "$env_file" "$key")"
  [[ "$actual" == "$expected" ]] || fail "Expected ${key}=${expected} in ${env_file}, found '${actual:-<missing>}'"
}

require_http_ok() {
  local url="$1"
  local label="$2"
  curl -fsS --max-time 5 "$url" >/dev/null 2>&1 || fail "${label} check failed: ${url}"
}

require_container_http_ok() {
  local container="$1"
  local url="$2"
  local label="$3"
  docker exec "$container" sh -lc "curl -fsS --max-time 5 '$url' >/dev/null 2>&1" || fail "${label} check failed in ${container}: ${url}"
}

normalize_clawdentity_version() {
  local raw="$1"
  raw="$(printf '%s' "$raw" | tr -d '[:space:]')"
  raw="${raw#rust/v}"
  raw="${raw#v}"
  printf '%s' "$raw"
}

resolve_version_from_preserved_env() {
  local alpha_env="$OPENCLAW_ALPHA_HOME/.env"
  local beta_env="$OPENCLAW_BETA_HOME/.env"
  local alpha_version
  local beta_version
  alpha_version="$(normalize_clawdentity_version "$(read_env_value "$alpha_env" "CLAWDENTITY_VERSION")")"
  beta_version="$(normalize_clawdentity_version "$(read_env_value "$beta_env" "CLAWDENTITY_VERSION")")"

  if [[ -n "$alpha_version" && -n "$beta_version" && "$alpha_version" != "$beta_version" ]]; then
    log "Warning: preserved profile versions differ (alpha=${alpha_version}, beta=${beta_version}); using alpha"
  fi

  if [[ -n "$alpha_version" ]]; then
    printf '%s' "$alpha_version"
    return 0
  fi
  if [[ -n "$beta_version" ]]; then
    printf '%s' "$beta_version"
    return 0
  fi
  return 1
}

resolve_version_from_local_cargo() {
  local cargo_toml="$REPO_ROOT/crates/clawdentity-cli/Cargo.toml"
  [[ -f "$cargo_toml" ]] || return 1
  awk -F'"' '/^version[[:space:]]*=[[:space:]]*"/ { print $2; exit }' "$cargo_toml"
}

resolve_latest_clawdentity_version() {
  local source="manifest"
  if [[ -n "${CLAWDENTITY_VERSION:-}" ]]; then
    CLAWDENTITY_LATEST_VERSION="$(normalize_clawdentity_version "${CLAWDENTITY_VERSION}")"
    source="env-override"
  else
    local fetched_version=""
    if fetched_version="$(
      curl -fsSL "$CLAWDENTITY_RELEASE_MANIFEST_URL" 2>/dev/null |
        node -e '
          let raw = "";
          process.stdin.on("data", (chunk) => {
            raw += chunk;
          });
          process.stdin.on("end", () => {
            const parsed = JSON.parse(raw);
            const version =
              typeof parsed.version === "string" ? parsed.version.trim() : "";
            if (!version) {
              process.exit(1);
            }
            process.stdout.write(version);
          });
        '
    )"; then
      CLAWDENTITY_LATEST_VERSION="$(normalize_clawdentity_version "$fetched_version")"
    else
      log "Warning: failed to resolve latest CLI version from $CLAWDENTITY_RELEASE_MANIFEST_URL"
      if CLAWDENTITY_LATEST_VERSION="$(resolve_version_from_preserved_env)"; then
        source="preserved-profile-env"
      else
        local cargo_version
        cargo_version="$(resolve_version_from_local_cargo || true)"
        cargo_version="$(normalize_clawdentity_version "$cargo_version")"
        if [[ -n "$cargo_version" ]]; then
          CLAWDENTITY_LATEST_VERSION="$cargo_version"
          source="local-cargo"
        fi
      fi
    fi
  fi

  [[ -n "$CLAWDENTITY_LATEST_VERSION" ]] || fail "Resolved CLI version is empty (set CLAWDENTITY_VERSION to override)"
  log "Using clawdentity version ${CLAWDENTITY_LATEST_VERSION} (source: ${source})"
}

build_local_clawdentity_cli() {
  [[ "$BUILD_CLI_BEFORE_TEST" == "1" ]] || return 0
  require_command cargo

  log "Building local clawdentity CLI from workspace"
  cargo build --manifest-path "$REPO_ROOT/crates/Cargo.toml" -p clawdentity-cli

  local cargo_target_dir="${CARGO_TARGET_DIR:-$REPO_ROOT/crates/target}"
  local cli_bin="$cargo_target_dir/debug/clawdentity-cli"
  [[ -x "$cli_bin" ]] || fail "Built CLI not found at $cli_bin"
  log "Local CLI build ready: $("$cli_bin" --version)"
}

sync_clawdentity_install_env() {
  node -e '
    const fs = require("fs");
    const envPaths = [process.argv[1], process.argv[2]];
    const version = process.argv[3];
    const manifestUrl = process.argv[4];
    const installDir = process.argv[5];
    const cliPath = process.argv[6];
    const defaultPath = "/home/node/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/local/games:/usr/games";

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

    for (const envPath of envPaths) {
      const raw = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
      let next = raw;
      next = upsertEnvValue(next, "CLAWDENTITY_VERSION", version);
      next = upsertEnvValue(next, "CLAWDENTITY_RELEASE_MANIFEST_URL", manifestUrl);
      next = upsertEnvValue(next, "CLAWDENTITY_INSTALL_DIR", installDir);
      next = upsertEnvValue(next, "CLAWDENTITY_CLI_PATH", cliPath);
      next = upsertEnvValue(next, "PATH", defaultPath);
      fs.writeFileSync(envPath, next);
    }
  ' \
    "$OPENCLAW_ALPHA_HOME/.env" \
    "$OPENCLAW_BETA_HOME/.env" \
    "$CLAWDENTITY_LATEST_VERSION" \
    "$CLAWDENTITY_RELEASE_MANIFEST_URL" \
    "$CLAWDENTITY_INSTALL_DIR_IN_CONTAINER" \
    "$CLAWDENTITY_CLI_PATH_IN_CONTAINER"
}

docker_compose_dual() {
  [[ -f "$DOCKER_COMPOSE_FILE" ]] || fail "docker compose file not found: $DOCKER_COMPOSE_FILE"
  docker compose -f "$DOCKER_COMPOSE_FILE" "$@"
}

start_device_pairing_autoapprove() {
  local container="$1"
  local duration_seconds="$2"
  local log_file="/tmp/${container}-device-autoapprove.log"
  local pid_file="/tmp/${container}-device-autoapprove.pid"

  nohup bash -lc "
    set -euo pipefail
    echo \$\$ > '${pid_file}'
    echo 'started container=${container} duration=${duration_seconds}s' >> '${log_file}'
    deadline=\$((SECONDS + ${duration_seconds}))

    while (( SECONDS < deadline )); do
      docker exec '${container}' sh -lc 'openclaw devices approve --latest --json >/dev/null 2>&1 || true' >/dev/null 2>&1 || true
      sleep 1
    done
    echo 'finished' >> '${log_file}'
  " >"$log_file" 2>&1 &
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
    if docker exec "$container" sh -lc "curl -fsS --max-time 2 http://127.0.0.1:${port}/ >/dev/null 2>&1"; then
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
    const profileArgs = [
      { configPath: process.argv[1], uiPort: process.argv[2], expectedAgentName: process.argv[3] },
      { configPath: process.argv[4], uiPort: process.argv[5], expectedAgentName: process.argv[6] },
    ];
    const registryUrl = process.argv[7];
    const proxyUrl = process.argv[8];
    const siteBaseUrl = process.argv[9];
    const openclawPolicyPath = process.argv[10];
    const execApprovalsPolicyPath = process.argv[11];
    const modelRef = process.argv[12];

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

    const allowedOriginsForPort = (uiPort) => [
      `http://localhost:${uiPort}`,
      `http://127.0.0.1:${uiPort}`,
    ];
    const openclawPolicy = JSON.parse(fs.readFileSync(openclawPolicyPath, "utf8"));
    const execApprovalsPolicy = JSON.parse(fs.readFileSync(execApprovalsPolicyPath, "utf8"));

    for (const { configPath, uiPort, expectedAgentName } of profileArgs) {
      const envPath = configPath.replace(/openclaw\.json$/, ".env");
      const profileHome = configPath.replace(/\/openclaw\.json$/, "");
      const envRaw = readEnvFile(envPath);
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
      cfg.agents = cfg.agents || {};
      cfg.agents.defaults = cfg.agents.defaults || {};
      if (typeof openclawPolicy.agents?.defaults?.elevatedDefault === "string") {
        cfg.agents.defaults.elevatedDefault = openclawPolicy.agents.defaults.elevatedDefault;
      }
      cfg.agents.defaults.model = {
        ...(typeof cfg.agents.defaults.model === "object" && cfg.agents.defaults.model !== null
          ? cfg.agents.defaults.model
          : {}),
        primary: modelRef,
      };
      cfg.agents.defaults.sandbox = {
        ...(typeof cfg.agents.defaults.sandbox === "object" && cfg.agents.defaults.sandbox !== null
          ? cfg.agents.defaults.sandbox
          : {}),
        ...(openclawPolicy.agents?.defaults?.sandbox || {}),
      };
      cfg.gateway = cfg.gateway || {};
      cfg.gateway.mode = openclawPolicy.gateway?.mode || "local";
      cfg.gateway.bind = openclawPolicy.gateway?.bind || "lan";
      cfg.gateway.auth = {
        ...(typeof cfg.gateway.auth === "object" && cfg.gateway.auth !== null ? cfg.gateway.auth : {}),
        ...(openclawPolicy.gateway?.auth || {}),
      };
      cfg.gateway.controlUi = {
        ...(cfg.gateway.controlUi || {}),
        ...(openclawPolicy.gateway?.controlUi || {}),
        allowedOrigins: allowedOriginsForPort(uiPort),
      };
      if (openclawPolicy.gateway?.controlUi?.dangerouslyDisableDeviceAuth !== true) {
        delete cfg.gateway.controlUi.dangerouslyDisableDeviceAuth;
      }
      cfg.tools = cfg.tools || {};
      cfg.tools.elevated = {
        ...(typeof cfg.tools.elevated === "object" && cfg.tools.elevated !== null
          ? cfg.tools.elevated
          : {}),
        ...(openclawPolicy.tools?.elevated || {}),
      };
      cfg.tools.exec = {
        ...(typeof cfg.tools.exec === "object" && cfg.tools.exec !== null ? cfg.tools.exec : {}),
        ...(openclawPolicy.tools?.exec || {}),
      };
      cfg.browser = cfg.browser || {};
      cfg.browser.ssrfPolicy = {
        ...(typeof cfg.browser.ssrfPolicy === "object" && cfg.browser.ssrfPolicy !== null
          ? cfg.browser.ssrfPolicy
          : {}),
        ...(openclawPolicy.browser?.ssrfPolicy || {}),
        allowedHostnames: Array.from(
          new Set([
            ...(Array.isArray(cfg.browser.ssrfPolicy?.allowedHostnames)
              ? cfg.browser.ssrfPolicy.allowedHostnames
              : []),
            ...(Array.isArray(openclawPolicy.browser?.ssrfPolicy?.allowedHostnames)
              ? openclawPolicy.browser.ssrfPolicy.allowedHostnames
              : []),
          ]),
        ),
      };
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
      nextEnvRaw = upsertEnvValue(nextEnvRaw, "CLAWDENTITY_SITE_BASE_URL", siteBaseUrl);
      nextEnvRaw = upsertEnvValue(nextEnvRaw, "CLAWDENTITY_EXPECTED_AGENT_NAME", expectedAgentName);
      nextEnvRaw = upsertEnvValue(nextEnvRaw, "CODEX_HOME", "/home/node/.openclaw/.codex");
      fs.writeFileSync(envPath, nextEnvRaw);
      const approvalsPath = `${profileHome}/exec-approvals.json`;
      let currentApprovals = {};
      if (fs.existsSync(approvalsPath)) {
        try {
          currentApprovals = JSON.parse(fs.readFileSync(approvalsPath, "utf8"));
        } catch {
          currentApprovals = {};
        }
      }
      const approvalsToken =
        typeof currentApprovals?.socket?.token === "string" && currentApprovals.socket.token.trim().length > 0
          ? currentApprovals.socket.token.trim()
          : crypto.randomBytes(24).toString("base64url");
      const nextApprovals = {
        ...execApprovalsPolicy,
        socket: {
          ...(execApprovalsPolicy.socket || {}),
          token: approvalsToken,
        },
      };
      fs.writeFileSync(approvalsPath, `${JSON.stringify(nextApprovals, null, 2)}\n`);
    }
  ' \
    "$OPENCLAW_ALPHA_HOME/openclaw.json" \
    "$ALPHA_UI_PORT" \
    "$ALPHA_EXPECTED_AGENT_NAME" \
    "$OPENCLAW_BETA_HOME/openclaw.json" \
    "$BETA_UI_PORT" \
    "$BETA_EXPECTED_AGENT_NAME" \
    "$DOCKER_REGISTRY_URL" \
    "$DOCKER_PROXY_URL" \
    "$DOCKER_SITE_BASE_URL" \
    "$LOCAL_OPENCLAW_POLICY_FILE" \
    "$LOCAL_EXEC_APPROVALS_FILE" \
    "$LOCAL_OPENCLAW_MODEL"
}

remove_skill_artifacts() {
  local profile_path="$1"
  rm -rf \
    "$profile_path/skills/clawdentity-openclaw-relay" \
    "$profile_path/workspace/skills/clawdentity-openclaw-relay"
  rm -f "$profile_path/hooks/transforms/relay-to-peer.mjs"
}

clear_runtime_state() {
  local profile_path="$1"
  rm -f "$profile_path/memory/main.sqlite"
  rm -f "$profile_path/workspace/.openclaw/workspace-state.json"
  rm -rf "$profile_path/.clawdentity"
  rm -rf "$profile_path/.clawdentity-cli"
  rm -rf "$profile_path/.clawdentity-state"
  rm -rf "$profile_path/workspace/.clawdentity"
  rm -rf "$profile_path/workspace/.clawdentity-cli"
  rm -rf "$profile_path/workspace/.clawdentity-state"
  if [[ -d "$profile_path/agents/main/sessions" ]]; then
    find "$profile_path/agents/main/sessions" -type f -delete
  fi
}

assert_profile_clean_state() {
  local profile_path="$1"
  local profile_name="$2"
  local sessions_count

  [[ ! -f "$profile_path/workspace/.openclaw/workspace-state.json" ]] || fail "${profile_name}: stale workspace-state.json present after reset"
  [[ ! -d "$profile_path/skills/clawdentity-openclaw-relay" ]] || fail "${profile_name}: skill artifacts survived reset"
  [[ ! -d "$profile_path/workspace/skills/clawdentity-openclaw-relay" ]] || fail "${profile_name}: workspace skill artifacts survived reset"
  [[ ! -f "$profile_path/hooks/transforms/relay-to-peer.mjs" ]] || fail "${profile_name}: relay transform survived reset"
  [[ ! -d "$profile_path/.clawdentity" ]] || fail "${profile_name}: profile-home clawdentity state survived reset"
  [[ ! -d "$profile_path/workspace/.clawdentity" ]] || fail "${profile_name}: clawdentity workspace state survived reset"
  [[ ! -d "$profile_path/workspace/.clawdentity-cli" ]] || fail "${profile_name}: clawdentity-cli workspace state survived reset"
  [[ ! -d "$profile_path/workspace/.clawdentity-state" ]] || fail "${profile_name}: clawdentity-state workspace state survived reset"

  sessions_count="$({ find "$profile_path/agents/main/sessions" -type f 2>/dev/null || true; } | wc -l | tr -d ' ')"
  [[ "$sessions_count" == "0" ]] || fail "${profile_name}: expected 0 saved sessions after reset, found ${sessions_count}"
}

assert_profile_env_contract() {
  local profile_path="$1"
  local profile_name="$2"
  local expected_agent_name="$3"
  local env_file="$profile_path/.env"

  assert_env_value "$env_file" "CLAWDENTITY_REGISTRY_URL" "$DOCKER_REGISTRY_URL"
  assert_env_value "$env_file" "CLAWDENTITY_PROXY_URL" "$DOCKER_PROXY_URL"
  assert_env_value "$env_file" "CLAWDENTITY_SITE_BASE_URL" "$DOCKER_SITE_BASE_URL"
  assert_env_value "$env_file" "CLAWDENTITY_VERSION" "$CLAWDENTITY_LATEST_VERSION"
  assert_env_value "$env_file" "CLAWDENTITY_RELEASE_MANIFEST_URL" "$CLAWDENTITY_RELEASE_MANIFEST_URL"
  assert_env_value "$env_file" "CLAWDENTITY_INSTALL_DIR" "$CLAWDENTITY_INSTALL_DIR_IN_CONTAINER"
  assert_env_value "$env_file" "CLAWDENTITY_CLI_PATH" "$CLAWDENTITY_CLI_PATH_IN_CONTAINER"
  assert_env_value "$env_file" "CLAWDENTITY_EXPECTED_AGENT_NAME" "$expected_agent_name"

  local path_value
  path_value="$(read_env_value "$env_file" "PATH")"
  [[ "$path_value" == *"/home/node/.local/bin"* ]] || fail "${profile_name}: PATH in ${env_file} is missing /home/node/.local/bin"
}

verify_host_stack_dependencies() {
  [[ "$VERIFY_STACK_DEPENDENCIES" == "1" ]] || return 0
  local host_skill_url="${HOST_SITE_BASE_URL%/}/skill.md"
  require_http_ok "${HOST_REGISTRY_URL%/}/health" "registry health"
  require_http_ok "${HOST_PROXY_URL%/}/health" "proxy health"
  require_http_ok "$host_skill_url" "landing skill"
}

verify_container_stack_dependencies() {
  [[ "$VERIFY_STACK_DEPENDENCIES" == "1" ]] || return 0

  local container
  for container in "$ALPHA_CONTAINER" "$BETA_CONTAINER"; do
    require_container_http_ok "$container" "${DOCKER_REGISTRY_URL%/}/health" "registry health"
    require_container_http_ok "$container" "${DOCKER_PROXY_URL%/}/health" "proxy health"
    require_container_http_ok "$container" "${DOCKER_SITE_BASE_URL%/}/skill.md" "landing skill"
  done
}

install_host_codex_auth() {
  local profile_path="$1"
  local target_dir="$profile_path/.codex"

  mkdir -p "$target_dir"
  cp "$HOST_CODEX_AUTH_FILE" "$target_dir/auth.json"
  chmod 600 "$target_dir/auth.json"
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
    console.log(`alpha_url=http://127.0.0.1:18789/#token=${alphaToken}`);
    console.log(`beta_url=http://127.0.0.1:19001/#token=${betaToken}`);
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
  require_file "$LOCAL_OPENCLAW_POLICY_FILE"
  require_file "$LOCAL_EXEC_APPROVALS_FILE"
  require_file "$HOST_CODEX_AUTH_FILE"

  resolve_latest_clawdentity_version
  build_local_clawdentity_cli
  verify_host_stack_dependencies

  tmp_dir="$(mktemp -d)"
  trap 'if [[ -n "${tmp_dir:-}" ]]; then rm -rf "$tmp_dir"; fi' EXIT

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
    log "Restoring preserved secret env configuration"
    copy_preserved_env_values "$tmp_dir/alpha.env" "$OPENCLAW_ALPHA_HOME/.env"
    copy_preserved_env_values "$tmp_dir/beta.env" "$OPENCLAW_BETA_HOME/.env"
  fi

  log "Applying gateway defaults + clearing runtime state"
  write_gateway_defaults
  sync_clawdentity_install_env
  install_host_codex_auth "$OPENCLAW_ALPHA_HOME"
  install_host_codex_auth "$OPENCLAW_BETA_HOME"
  clear_runtime_state "$OPENCLAW_ALPHA_HOME"
  clear_runtime_state "$OPENCLAW_BETA_HOME"
  remove_skill_artifacts "$OPENCLAW_ALPHA_HOME"
  remove_skill_artifacts "$OPENCLAW_BETA_HOME"
  assert_profile_clean_state "$OPENCLAW_ALPHA_HOME" "alpha"
  assert_profile_clean_state "$OPENCLAW_BETA_HOME" "beta"
  assert_profile_env_contract "$OPENCLAW_ALPHA_HOME" "alpha" "$ALPHA_EXPECTED_AGENT_NAME"
  assert_profile_env_contract "$OPENCLAW_BETA_HOME" "beta" "$BETA_EXPECTED_AGENT_NAME"

  log "Starting dual OpenClaw stack"
  docker_compose_dual up -d

  wait_for_ui 18789 "$ALPHA_CONTAINER"
  wait_for_ui 19001 "$BETA_CONTAINER"
  verify_container_stack_dependencies
  log "Starting temporary Control UI device auto-approval watchers"
  start_device_pairing_autoapprove "$ALPHA_CONTAINER" "$DEVICE_AUTO_APPROVE_SECONDS"
  start_device_pairing_autoapprove "$BETA_CONTAINER" "$DEVICE_AUTO_APPROVE_SECONDS"

  print_urls

  printf 'alpha_sessions=%s\n' "$(find "$OPENCLAW_ALPHA_HOME/agents/main/sessions" -type f 2>/dev/null | wc -l | tr -d ' ')"
  printf 'beta_sessions=%s\n' "$(find "$OPENCLAW_BETA_HOME/agents/main/sessions" -type f 2>/dev/null | wc -l | tr -d ' ')"
  [[ -d "$OPENCLAW_ALPHA_HOME/skills/clawdentity-openclaw-relay" ]] && echo "alpha_skill_present=1" || echo "alpha_skill_present=0"
  [[ -d "$OPENCLAW_BETA_HOME/skills/clawdentity-openclaw-relay" ]] && echo "beta_skill_present=1" || echo "beta_skill_present=0"
  echo "alpha_expected_agent_name=${ALPHA_EXPECTED_AGENT_NAME}"
  echo "beta_expected_agent_name=${BETA_EXPECTED_AGENT_NAME}"
  echo "verify_stack_dependencies=${VERIFY_STACK_DEPENDENCIES}"
  log "Ready state complete"
}

run
