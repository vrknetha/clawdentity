#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCAL_PROFILE_DIR="${LOCAL_PROFILE_DIR:-$SCRIPT_DIR/openclaw-local-profile}"
LOCAL_OPENCLAW_POLICY_FILE="${LOCAL_OPENCLAW_POLICY_FILE:-$LOCAL_PROFILE_DIR/openclaw.json}"
LOCAL_EXEC_APPROVALS_FILE="${LOCAL_EXEC_APPROVALS_FILE:-$LOCAL_PROFILE_DIR/exec-approvals.json}"
HOST_CODEX_AUTH_FILE="${HOST_CODEX_AUTH_FILE:-$HOME/.codex/auth.json}"

OPENCLAW_AGENT_IDS="${OPENCLAW_AGENT_IDS:-alpha,beta}"
OPENCLAW_PERSONALITY_SOURCE_HOME="${OPENCLAW_PERSONALITY_SOURCE_HOME:-$HOME/.openclaw-alpha}"
OPENCLAW_IMAGE="${OPENCLAW_IMAGE:-openclaw:local}"
OPENCLAW_MODEL="${OPENCLAW_MODEL:-openai-codex/gpt-5.4}"
OPENCLAW_FALLBACK_MODEL="${OPENCLAW_FALLBACK_MODEL:-openrouter/moonshotai/kimi-k2.5}"

OPENCLAW_UI_PORT_BASE="${OPENCLAW_UI_PORT_BASE:-18789}"
OPENCLAW_API_PORT_BASE="${OPENCLAW_API_PORT_BASE:-18790}"
OPENCLAW_PORT_STRIDE="${OPENCLAW_PORT_STRIDE:-212}"

DOCKER_COMPOSE_FILE_GENERATED="${DOCKER_COMPOSE_FILE_GENERATED:-$REPO_ROOT/.tmp/docker-compose.openclaw.generated.yml}"
DOCKER_STACK_NAME="${DOCKER_STACK_NAME:-clawdbot}"

PRESERVE_ENV="${PRESERVE_ENV:-1}"
PRUNE_ORPHAN_AGENT_HOMES="${PRUNE_ORPHAN_AGENT_HOMES:-0}"
VERIFY_STACK_DEPENDENCIES="${VERIFY_STACK_DEPENDENCIES:-1}"
REQUIRE_APP_REGISTRY_GROUPS_ROUTE="${REQUIRE_APP_REGISTRY_GROUPS_ROUTE:-1}"
OPENCLAW_SCALER_VALIDATE_ONLY="${OPENCLAW_SCALER_VALIDATE_ONLY:-0}"
WAIT_TIMEOUT_SECONDS="${WAIT_TIMEOUT_SECONDS:-90}"
DEVICE_AUTO_APPROVE_SECONDS="${DEVICE_AUTO_APPROVE_SECONDS:-180}"

CLAWDENTITY_SITE_BASE_URL="${CLAWDENTITY_SITE_BASE_URL:-http://localhost:4321}"
DOCKER_SITE_BASE_URL="${DOCKER_SITE_BASE_URL:-http://host.docker.internal:4321}"
HOST_SITE_BASE_URL="${HOST_SITE_BASE_URL:-$CLAWDENTITY_SITE_BASE_URL}"
PUBLIC_SITE_BASE_URL="${PUBLIC_SITE_BASE_URL:-}"
WEB_FETCH_SKILL_URL="${WEB_FETCH_SKILL_URL:-}"
if [[ -z "$WEB_FETCH_SKILL_URL" ]]; then
  if [[ -n "$PUBLIC_SITE_BASE_URL" ]]; then
    WEB_FETCH_SKILL_URL="${PUBLIC_SITE_BASE_URL%/}/skill.md"
  else
    WEB_FETCH_SKILL_URL="${HOST_SITE_BASE_URL%/}/skill.md"
  fi
fi
DOCKER_REGISTRY_URL="${DOCKER_REGISTRY_URL:-http://host.docker.internal:8788}"
DOCKER_PROXY_URL="${DOCKER_PROXY_URL:-http://host.docker.internal:8787}"
HOST_REGISTRY_URL="${HOST_REGISTRY_URL:-${CLAWDENTITY_REGISTRY_URL:-http://127.0.0.1:8788}}"
HOST_PROXY_URL="${HOST_PROXY_URL:-${CLAWDENTITY_PROXY_URL:-http://127.0.0.1:8787}}"

CLAWDENTITY_RELEASE_MANIFEST_URL_INPUT="${CLAWDENTITY_RELEASE_MANIFEST_URL:-}"
CLAWDENTITY_RELEASE_MANIFEST_URL="${CLAWDENTITY_RELEASE_MANIFEST_URL_INPUT:-${DOCKER_SITE_BASE_URL%/}/rust/latest-local.json}"
CLAWDENTITY_VERSION="${CLAWDENTITY_VERSION:-}"
CLAWDENTITY_INSTALL_DIR_IN_CONTAINER="${CLAWDENTITY_INSTALL_DIR_IN_CONTAINER:-/home/node/.local/bin}"
CLAWDENTITY_CLI_PATH_IN_CONTAINER="${CLAWDENTITY_CLI_PATH_IN_CONTAINER:-/home/node/.local/bin/clawdentity}"

SECRET_ENV_KEYS=(
  OPENROUTER_API_KEY
  OPENAI_API_KEY
  OPENCLAW_GATEWAY_TOKEN
)

declare -a AGENT_IDS=()
declare -a AGENT_HOMES=()
declare -a AGENT_CONTAINERS=()
declare -a AGENT_SERVICES=()
declare -a AGENT_UI_PORTS=()
declare -a AGENT_API_PORTS=()
declare -a AGENT_EXPECTED_NAMES=()
declare -A DESIRED_CONTAINER_SET=()
declare -A DESIRED_HOME_SET=()
declare -a REMOVED_ORPHAN_CONTAINERS=()
declare -a REMOVED_DESIRED_CONTAINERS=()
declare -a PRUNED_ORPHAN_HOMES=()
declare -a RESET_AGENT_HOMES=()
PRESTART_STACK_DOWN_RAN=0

log() {
  printf '[openclaw-relay-scalable] %s\n' "$*"
}

fail() {
  printf '[openclaw-relay-scalable] ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

require_file() {
  local path="$1"
  [[ -f "$path" ]] || fail "File not found: $path"
}

require_dir() {
  local path="$1"
  [[ -d "$path" ]] || fail "Directory not found: $path"
}

trim() {
  local value="$1"
  value="${value#${value%%[![:space:]]*}}"
  value="${value%${value##*[![:space:]]}}"
  printf '%s' "$value"
}

normalize_agent_ids() {
  local raw="$1"
  local token normalized
  declare -A seen=()

  IFS=',' read -r -a tokens <<< "$raw"
  for token in "${tokens[@]}"; do
    normalized="$(trim "$token")"
    [[ -n "$normalized" ]] || continue

    if [[ ! "$normalized" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
      fail "Invalid agent id '$normalized'. Allowed pattern: ^[a-z0-9][a-z0-9-]*$"
    fi

    if [[ -n "${seen[$normalized]:-}" ]]; then
      continue
    fi

    seen[$normalized]=1
    AGENT_IDS+=("$normalized")
  done

  [[ "${#AGENT_IDS[@]}" -gt 0 ]] || fail "OPENCLAW_AGENT_IDS resolved to empty agent list"
}

build_agent_matrix() {
  local idx id ui_port api_port container_name service_name home expected_name
  declare -A seen_ui_ports=()
  declare -A seen_api_ports=()
  declare -A seen_host_ports=()

  if ! [[ "$OPENCLAW_UI_PORT_BASE" =~ ^[0-9]+$ ]] || ! [[ "$OPENCLAW_API_PORT_BASE" =~ ^[0-9]+$ ]] || ! [[ "$OPENCLAW_PORT_STRIDE" =~ ^[0-9]+$ ]]; then
    fail "Port inputs must be numeric: OPENCLAW_UI_PORT_BASE, OPENCLAW_API_PORT_BASE, OPENCLAW_PORT_STRIDE"
  fi

  for idx in "${!AGENT_IDS[@]}"; do
    id="${AGENT_IDS[$idx]}"
    ui_port=$((OPENCLAW_UI_PORT_BASE + (idx * OPENCLAW_PORT_STRIDE)))
    api_port=$((OPENCLAW_API_PORT_BASE + (idx * OPENCLAW_PORT_STRIDE)))

    ((ui_port > 0 && ui_port <= 65535)) || fail "Computed UI port out of range for '$id': $ui_port"
    ((api_port > 0 && api_port <= 65535)) || fail "Computed API port out of range for '$id': $api_port"
    [[ "$ui_port" != "$api_port" ]] || fail "Host port collision for '$id': UI and API both resolve to $ui_port"

    [[ -z "${seen_ui_ports[$ui_port]:-}" ]] || fail "UI port collision detected: $ui_port"
    [[ -z "${seen_api_ports[$api_port]:-}" ]] || fail "API port collision detected: $api_port"
    [[ -z "${seen_host_ports[$ui_port]:-}" ]] || fail "Host port collision detected: $ui_port"
    [[ -z "${seen_host_ports[$api_port]:-}" ]] || fail "Host port collision detected: $api_port"
    seen_ui_ports[$ui_port]=1
    seen_api_ports[$api_port]=1
    seen_host_ports[$ui_port]=1
    seen_host_ports[$api_port]=1

    container_name="clawdbot-agent-${id}-1"
    service_name="agent-${id}"
    home="$HOME/.openclaw-${id}"
    expected_name="${id}-local"

    AGENT_CONTAINERS+=("$container_name")
    AGENT_SERVICES+=("$service_name")
    AGENT_HOMES+=("$home")
    AGENT_EXPECTED_NAMES+=("$expected_name")
    AGENT_UI_PORTS+=("$ui_port")
    AGENT_API_PORTS+=("$api_port")

    DESIRED_CONTAINER_SET[$container_name]=1
    DESIRED_HOME_SET[$home]=1
  done
}

preserve_secret_env_values() {
  local source_env="$1"
  local target_env="$2"

  [[ "$PRESERVE_ENV" == "1" ]] || return 0
  [[ -f "$source_env" ]] || return 0

  local key value
  for key in "${SECRET_ENV_KEYS[@]}"; do
    value="$(awk -F= -v search="$key" '
      $0 ~ /^[[:space:]]*#/ { next }
      $1 == search { print substr($0, index($0, "=") + 1); exit }
    ' "$source_env")"

    [[ -n "$value" ]] || continue

    node -e '
      const fs = require("fs");
      const [targetPath, key, value] = process.argv.slice(1);
      const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const line = `${key}=${value}`;
      let raw = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : "";
      const pattern = new RegExp(`^\\s*${escapedKey}\\s*=.*$`, "m");
      if (pattern.test(raw)) {
        raw = raw.replace(pattern, line);
      } else if (raw.trim().length === 0) {
        raw = `${line}\n`;
      } else {
        raw = raw.endsWith("\n") ? `${raw}${line}\n` : `${raw}\n${line}\n`;
      }
      fs.writeFileSync(targetPath, raw);
    ' "$target_env" "$key" "$value"
  done
}

apply_openclaw_profile_defaults() {
  local home="$1"
  local ui_port="$2"
  local expected_agent_name="$3"

  node -e '
    const fs = require("fs");
    const crypto = require("crypto");

    const [
      home,
      uiPort,
      policyPath,
      approvalsPath,
      modelRef,
      registryUrl,
      proxyUrl,
      siteBaseUrl,
      expectedAgentName,
      releaseManifestUrl,
      downloadsBaseUrl,
      installDir,
      cliPath,
      clawdentityVersion,
      modelFallbackRef,
      openrouterApiKey,
    ] = process.argv.slice(1);

    const configPath = `${home}/openclaw.json`;
    const envPath = `${home}/.env`;

    const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
    const approvalsTemplate = JSON.parse(fs.readFileSync(approvalsPath, "utf8"));
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));

    const parseEnvValue = (raw, key) => {
      for (const line of raw.split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
        if (!match) continue;
        if (match[1] !== key) continue;
        return match[2].trim().replace(/^"+|"+$/g, "");
      }
      return null;
    };

    const upsertEnvValue = (raw, key, value) => {
      const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const line = `${key}=${value}`;
      const pattern = new RegExp(`^\\s*${escapedKey}\\s*=.*$`, "m");
      if (pattern.test(raw)) {
        const next = raw.replace(pattern, line);
        return next.endsWith("\n") ? next : `${next}\n`;
      }
      if (raw.trim().length === 0) {
        return `${line}\n`;
      }
      return raw.endsWith("\n") ? `${raw}${line}\n` : `${raw}\n${line}\n`;
    };

    const ensurePathIncludes = (raw) => {
      const match = raw.match(/^\s*PATH\s*=(.*)$/m);
      const existing = match ? match[1].trim() : "";
      const defaultPath = "/home/node/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/local/games:/usr/games";
      const parts = (existing.length > 0 ? existing : defaultPath)
        .split(":")
        .map((value) => value.trim())
        .filter(Boolean);
      if (!parts.includes("/home/node/.local/bin")) {
        parts.unshift("/home/node/.local/bin");
      }
      return upsertEnvValue(raw, "PATH", parts.join(":"));
    };

    cfg.agents = cfg.agents || {};
    cfg.agents.defaults = cfg.agents.defaults || {};
    if (typeof policy.agents?.defaults?.elevatedDefault === "string") {
      cfg.agents.defaults.elevatedDefault = policy.agents.defaults.elevatedDefault;
    }
    cfg.agents.defaults.model = {
      ...(typeof cfg.agents.defaults.model === "object" && cfg.agents.defaults.model !== null
        ? cfg.agents.defaults.model
        : {}),
      primary: modelRef,
      fallbacks: [modelFallbackRef],
    };
    cfg.agents.defaults.sandbox = {
      ...(typeof cfg.agents.defaults.sandbox === "object" && cfg.agents.defaults.sandbox !== null
        ? cfg.agents.defaults.sandbox
        : {}),
      ...(policy.agents?.defaults?.sandbox || {}),
    };

    cfg.gateway = cfg.gateway || {};
    cfg.gateway.mode = policy.gateway?.mode || "local";
    cfg.gateway.bind = policy.gateway?.bind || "lan";
    cfg.gateway.auth = {
      ...(typeof cfg.gateway.auth === "object" && cfg.gateway.auth !== null ? cfg.gateway.auth : {}),
      ...(policy.gateway?.auth || {}),
    };
    cfg.gateway.controlUi = {
      ...(typeof cfg.gateway.controlUi === "object" && cfg.gateway.controlUi !== null ? cfg.gateway.controlUi : {}),
      ...(policy.gateway?.controlUi || {}),
      allowedOrigins: [`http://localhost:${uiPort}`, `http://127.0.0.1:${uiPort}`],
    };
    if (policy.gateway?.controlUi?.dangerouslyDisableDeviceAuth !== true) {
      delete cfg.gateway.controlUi.dangerouslyDisableDeviceAuth;
    }

    cfg.tools = cfg.tools || {};
    cfg.tools.elevated = {
      ...(typeof cfg.tools.elevated === "object" && cfg.tools.elevated !== null ? cfg.tools.elevated : {}),
      ...(policy.tools?.elevated || {}),
    };
    cfg.tools.exec = {
      ...(typeof cfg.tools.exec === "object" && cfg.tools.exec !== null ? cfg.tools.exec : {}),
      ...(policy.tools?.exec || {}),
    };
    const normalizeToolEntry = (entry) =>
      typeof entry === "string" ? entry.trim().toLowerCase() : "";
    const toToolList = (value) => {
      if (Array.isArray(value)) {
        return value.filter((entry) => typeof entry === "string" && entry.trim().length > 0);
      }
      if (typeof value === "string" && value.trim().length > 0) {
        return [value.trim()];
      }
      return null;
    };
    const blockedEntries = new Set(["web_fetch", "group:web"]);
    const denyList = toToolList(cfg.tools.deny);
    if (denyList !== null) {
      cfg.tools.deny = denyList.filter((entry) => !blockedEntries.has(normalizeToolEntry(entry)));
    }
    const allowList = toToolList(cfg.tools.allow);
    if (allowList !== null) {
      const hasWebAccess = allowList.some((entry) => blockedEntries.has(normalizeToolEntry(entry)));
      cfg.tools.allow = hasWebAccess ? allowList : [...allowList, "group:web"];
    }
    cfg.tools.web = {
      ...(typeof cfg.tools.web === "object" && cfg.tools.web !== null ? cfg.tools.web : {}),
    };
    cfg.tools.web.fetch = {
      ...(typeof cfg.tools.web.fetch === "object" && cfg.tools.web.fetch !== null ? cfg.tools.web.fetch : {}),
      ...(policy.tools?.web?.fetch || {}),
      enabled: true,
    };

    cfg.browser = cfg.browser || {};
    cfg.browser.ssrfPolicy = {
      ...(typeof cfg.browser.ssrfPolicy === "object" && cfg.browser.ssrfPolicy !== null ? cfg.browser.ssrfPolicy : {}),
      ...(policy.browser?.ssrfPolicy || {}),
      allowedHostnames: Array.from(
        new Set([
          ...(Array.isArray(cfg.browser.ssrfPolicy?.allowedHostnames) ? cfg.browser.ssrfPolicy.allowedHostnames : []),
          ...(Array.isArray(policy.browser?.ssrfPolicy?.allowedHostnames)
            ? policy.browser.ssrfPolicy.allowedHostnames
            : []),
        ]),
      ),
    };

    const envRaw = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
    const tokenFromEnv = parseEnvValue(envRaw, "OPENCLAW_GATEWAY_TOKEN");
    const tokenFromConfig =
      typeof cfg.gateway.auth.token === "string" && cfg.gateway.auth.token.trim().length > 0
        ? cfg.gateway.auth.token.trim()
        : null;
    const gatewayToken = tokenFromEnv || tokenFromConfig || crypto.randomBytes(24).toString("hex");
    cfg.gateway.auth.token = gatewayToken;

    fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`);

    let nextEnv = envRaw;
    nextEnv = upsertEnvValue(nextEnv, "OPENCLAW_GATEWAY_TOKEN", gatewayToken);
    nextEnv = upsertEnvValue(nextEnv, "CLAWDENTITY_REGISTRY_URL", registryUrl);
    nextEnv = upsertEnvValue(nextEnv, "CLAWDENTITY_PROXY_URL", proxyUrl);
    nextEnv = upsertEnvValue(nextEnv, "CLAWDENTITY_SITE_BASE_URL", siteBaseUrl);
    nextEnv = upsertEnvValue(nextEnv, "CLAWDENTITY_EXPECTED_AGENT_NAME", expectedAgentName);
    nextEnv = upsertEnvValue(nextEnv, "CODEX_HOME", "/home/node/.openclaw/.codex");
    nextEnv = upsertEnvValue(nextEnv, "CLAWDENTITY_RELEASE_MANIFEST_URL", releaseManifestUrl);
    nextEnv = upsertEnvValue(nextEnv, "CLAWDENTITY_DOWNLOADS_BASE_URL", downloadsBaseUrl);
    nextEnv = upsertEnvValue(nextEnv, "CLAWDENTITY_INSTALL_DIR", installDir);
    nextEnv = upsertEnvValue(nextEnv, "CLAWDENTITY_CLI_PATH", cliPath);
    if (clawdentityVersion.trim().length > 0) {
      nextEnv = upsertEnvValue(nextEnv, "CLAWDENTITY_VERSION", clawdentityVersion.trim());
    }
    if (typeof openrouterApiKey === "string" && openrouterApiKey.trim().length > 0) {
      nextEnv = upsertEnvValue(nextEnv, "OPENROUTER_API_KEY", openrouterApiKey.trim());
    }
    nextEnv = ensurePathIncludes(nextEnv);
    fs.writeFileSync(envPath, nextEnv);

    const approvalsTargetPath = `${home}/exec-approvals.json`;
    let existingApprovals = {};
    if (fs.existsSync(approvalsTargetPath)) {
      try {
        existingApprovals = JSON.parse(fs.readFileSync(approvalsTargetPath, "utf8"));
      } catch {
        existingApprovals = {};
      }
    }

    const approvalsSocketToken =
      typeof existingApprovals?.socket?.token === "string" && existingApprovals.socket.token.trim().length > 0
        ? existingApprovals.socket.token.trim()
        : crypto.randomBytes(24).toString("base64url");

    const nextApprovals = {
      ...approvalsTemplate,
      socket: {
        ...(approvalsTemplate.socket || {}),
        token: approvalsSocketToken,
      },
    };

    fs.writeFileSync(approvalsTargetPath, `${JSON.stringify(nextApprovals, null, 2)}\n`);
  ' \
    "$home" \
    "$ui_port" \
    "$LOCAL_OPENCLAW_POLICY_FILE" \
    "$LOCAL_EXEC_APPROVALS_FILE" \
    "$OPENCLAW_MODEL" \
    "$DOCKER_REGISTRY_URL" \
    "$DOCKER_PROXY_URL" \
    "$DOCKER_SITE_BASE_URL" \
    "$expected_agent_name" \
    "$CLAWDENTITY_RELEASE_MANIFEST_URL" \
    "${DOCKER_SITE_BASE_URL%/}" \
    "$CLAWDENTITY_INSTALL_DIR_IN_CONTAINER" \
    "$CLAWDENTITY_CLI_PATH_IN_CONTAINER" \
    "$CLAWDENTITY_VERSION" \
    "$OPENCLAW_FALLBACK_MODEL" \
    "${OPENROUTER_API_KEY:-}"
}

install_host_codex_auth() {
  local home="$1"
  [[ -f "$HOST_CODEX_AUTH_FILE" ]] || return 0

  mkdir -p "$home/.codex"
  cp "$HOST_CODEX_AUTH_FILE" "$home/.codex/auth.json"
  chmod 600 "$home/.codex/auth.json"
}

remove_skill_artifacts() {
  local home="$1"
  rm -rf \
    "$home/skills/clawdentity-openclaw-relay" \
    "$home/workspace/skills/clawdentity-openclaw-relay"
  rm -f "$home/hooks/transforms/relay-to-peer.mjs"
}

clear_runtime_state() {
  local home="$1"

  rm -f "$home/memory/main.sqlite"
  rm -f "$home/workspace/.openclaw/workspace-state.json"
  rm -rf "$home/.clawdentity" "$home/.clawdentity-cli" "$home/.clawdentity-state"
  rm -rf "$home/workspace/.clawdentity" "$home/workspace/.clawdentity-cli" "$home/workspace/.clawdentity-state"

  if [[ -d "$home/agents/main/sessions" ]]; then
    find "$home/agents/main/sessions" -type f -delete
  fi
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

assert_profile_clean_state() {
  local home="$1"
  local profile_name="$2"
  local sessions_count

  [[ ! -f "$home/workspace/.openclaw/workspace-state.json" ]] || fail "${profile_name}: stale workspace-state.json present after reset"
  [[ ! -d "$home/skills/clawdentity-openclaw-relay" ]] || fail "${profile_name}: skill artifacts survived reset"
  [[ ! -d "$home/workspace/skills/clawdentity-openclaw-relay" ]] || fail "${profile_name}: workspace skill artifacts survived reset"
  [[ ! -f "$home/hooks/transforms/relay-to-peer.mjs" ]] || fail "${profile_name}: relay transform survived reset"
  [[ ! -d "$home/.clawdentity" ]] || fail "${profile_name}: profile-home clawdentity state survived reset"
  [[ ! -d "$home/workspace/.clawdentity" ]] || fail "${profile_name}: clawdentity workspace state survived reset"
  [[ ! -d "$home/workspace/.clawdentity-cli" ]] || fail "${profile_name}: clawdentity-cli workspace state survived reset"
  [[ ! -d "$home/workspace/.clawdentity-state" ]] || fail "${profile_name}: clawdentity-state workspace state survived reset"

  sessions_count="$({ find "$home/agents/main/sessions" -type f 2>/dev/null || true; } | wc -l | tr -d ' ')"
  [[ "$sessions_count" == "0" ]] || fail "${profile_name}: expected 0 saved sessions after reset, found ${sessions_count}"
}

clear_gateway_token_seed() {
  local home="$1"
  node -e '
    const fs = require("fs");
    const home = process.argv[1];
    const envPath = `${home}/.env`;
    const configPath = `${home}/openclaw.json`;

    if (fs.existsSync(envPath)) {
      const nextEnv = fs
        .readFileSync(envPath, "utf8")
        .split(/\r?\n/)
        .filter((line) => !/^\s*OPENCLAW_GATEWAY_TOKEN\s*=/.test(line))
        .join("\n")
        .replace(/\n+$/, "");
      fs.writeFileSync(envPath, nextEnv.length > 0 ? `${nextEnv}\n` : "");
    }

    if (fs.existsSync(configPath)) {
      let cfg;
      try {
        cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
      } catch {
        cfg = {};
      }
      if (cfg && typeof cfg === "object" && cfg.gateway && typeof cfg.gateway === "object" && cfg.gateway.auth && typeof cfg.gateway.auth === "object") {
        delete cfg.gateway.auth.token;
      }
      fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
    }
  ' "$home"
}

verify_profile_contract() {
  local home="$1"
  local profile_label="$2"
  local expected_name="$3"
  local env_file="$home/.env"

  [[ -f "$env_file" ]] || fail "$profile_label: missing .env after profile prep"
  assert_env_value "$env_file" "CLAWDENTITY_REGISTRY_URL" "$DOCKER_REGISTRY_URL"
  assert_env_value "$env_file" "CLAWDENTITY_PROXY_URL" "$DOCKER_PROXY_URL"
  assert_env_value "$env_file" "CLAWDENTITY_SITE_BASE_URL" "$DOCKER_SITE_BASE_URL"
  assert_env_value "$env_file" "CLAWDENTITY_EXPECTED_AGENT_NAME" "$expected_name"
  assert_env_value "$env_file" "CLAWDENTITY_RELEASE_MANIFEST_URL" "$CLAWDENTITY_RELEASE_MANIFEST_URL"
  assert_env_value "$env_file" "CLAWDENTITY_DOWNLOADS_BASE_URL" "${DOCKER_SITE_BASE_URL%/}"
  assert_env_value "$env_file" "CLAWDENTITY_INSTALL_DIR" "$CLAWDENTITY_INSTALL_DIR_IN_CONTAINER"
  assert_env_value "$env_file" "CLAWDENTITY_CLI_PATH" "$CLAWDENTITY_CLI_PATH_IN_CONTAINER"

  local path_value
  path_value="$(read_env_value "$env_file" "PATH")"
  [[ "$path_value" == *"/home/node/.local/bin"* ]] || fail "$profile_label: PATH in $env_file is missing /home/node/.local/bin"

  assert_profile_clean_state "$home" "$profile_label"
}

prepare_agent_profiles() {
  local idx id home ui_port expected_name saved_env source_snapshot

  source_snapshot="$(mktemp -d)"
  rsync -a --delete "$OPENCLAW_PERSONALITY_SOURCE_HOME/" "$source_snapshot/"
  [[ -f "$source_snapshot/openclaw.json" ]] || fail "Personality source snapshot missing openclaw.json: $source_snapshot"

  for idx in "${!AGENT_IDS[@]}"; do
    id="${AGENT_IDS[$idx]}"
    home="${AGENT_HOMES[$idx]}"
    ui_port="${AGENT_UI_PORTS[$idx]}"
    expected_name="${AGENT_EXPECTED_NAMES[$idx]}"

    saved_env=""
    if [[ "$PRESERVE_ENV" == "1" && -f "$home/.env" ]]; then
      saved_env="$(mktemp)"
      cp "$home/.env" "$saved_env"
    fi

    rm -rf "$home"
    mkdir -p "$home"
    rsync -a --delete "$source_snapshot/" "$home/"

    if [[ -n "$saved_env" ]]; then
      preserve_secret_env_values "$saved_env" "$home/.env"
      rm -f "$saved_env"
    else
      clear_gateway_token_seed "$home"
    fi

    apply_openclaw_profile_defaults "$home" "$ui_port" "$expected_name"
    install_host_codex_auth "$home"
    remove_skill_artifacts "$home"
    clear_runtime_state "$home"
    verify_profile_contract "$home" "$id" "$expected_name"
    RESET_AGENT_HOMES+=("$home")
  done

  rm -rf "$source_snapshot"
}

generate_compose_file() {
  mkdir -p "$(dirname "$DOCKER_COMPOSE_FILE_GENERATED")"

  {
    printf 'name: %s\n\n' "$DOCKER_STACK_NAME"
    printf 'services:\n'

    local idx service container home ui_port api_port
    for idx in "${!AGENT_IDS[@]}"; do
      service="${AGENT_SERVICES[$idx]}"
      container="${AGENT_CONTAINERS[$idx]}"
      home="${AGENT_HOMES[$idx]}"
      ui_port="${AGENT_UI_PORTS[$idx]}"
      api_port="${AGENT_API_PORTS[$idx]}"
      printf '  %s:\n' "$service"
      printf '    container_name: %s\n' "$container"
      printf '    image: %s\n' "$OPENCLAW_IMAGE"
      printf '    env_file:\n'
      printf '      - %s/.env\n' "$home"
      printf '    environment:\n'
      printf '      HOME: /home/node\n'
      printf '      TERM: xterm-256color\n'
      printf '      CLAWDENTITY_REGISTRY_URL: %s\n' "$DOCKER_REGISTRY_URL"
      printf '      CLAWDENTITY_PROXY_URL: %s\n' "$DOCKER_PROXY_URL"
      printf '    volumes:\n'
      printf '      - %s:/home/node/.openclaw\n' "$home"
      printf '      - %s/workspace:/home/node/.openclaw/workspace\n' "$home"
      printf '    ports:\n'
      printf '      - "%s:18789"\n' "$ui_port"
      printf '      - "%s:18790"\n' "$api_port"
      printf '    init: true\n'
      printf '    restart: unless-stopped\n'
      printf '    command:\n'
      printf '      ["node", "openclaw.mjs", "gateway", "--allow-unconfigured", "--bind", "lan", "--port", "18789"]\n'
      printf '    networks:\n'
      printf '      - openclaw-net\n\n'
    done

    printf 'networks:\n'
    printf '  openclaw-net:\n'
    printf '    name: %s_openclaw-net\n' "$DOCKER_STACK_NAME"
  } > "$DOCKER_COMPOSE_FILE_GENERATED"
}

compose_generated() {
  docker compose -f "$DOCKER_COMPOSE_FILE_GENERATED" "$@"
}

remove_orphan_managed_containers() {
  local name
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    if [[ -z "${DESIRED_CONTAINER_SET[$name]:-}" ]]; then
      log "Removing orphan managed container: $name"
      docker rm -f "$name" >/dev/null 2>&1 || true
      REMOVED_ORPHAN_CONTAINERS+=("$name")
    fi
  done < <(docker ps -a --format '{{.Names}}' | rg '^clawdbot-agent-' -N || true)
}

remove_existing_desired_containers() {
  local container
  for container in "${AGENT_CONTAINERS[@]}"; do
    if docker ps -a --format '{{.Names}}' | rg -x "$container" -N >/dev/null 2>&1; then
      log "Removing existing managed container for reset: $container"
      docker rm -f "$container" >/dev/null 2>&1 || true
      REMOVED_DESIRED_CONTAINERS+=("$container")
    fi
  done
}

remove_orphan_agent_homes() {
  [[ "$PRUNE_ORPHAN_AGENT_HOMES" == "1" ]] || return 0

  local dir base
  for dir in "$HOME"/.openclaw-*; do
    [[ -d "$dir" ]] || continue
    base="$(basename "$dir")"
    [[ "$base" != ".openclaw-baselines" ]] || continue
    [[ -f "$dir/openclaw.json" ]] || continue
    if [[ -z "${DESIRED_HOME_SET[$dir]:-}" ]]; then
      log "Pruning orphan agent home: $dir"
      rm -rf "$dir"
      PRUNED_ORPHAN_HOMES+=("$dir")
    fi
  done
}

prestart_cleanup() {
  PRESTART_STACK_DOWN_RAN=0
  REMOVED_ORPHAN_CONTAINERS=()
  REMOVED_DESIRED_CONTAINERS=()
  PRUNED_ORPHAN_HOMES=()
  RESET_AGENT_HOMES=()

  if [[ -f "$DOCKER_COMPOSE_FILE_GENERATED" ]]; then
    log "Stopping previous generated stack"
    PRESTART_STACK_DOWN_RAN=1
    compose_generated down --remove-orphans >/dev/null 2>&1 || true
  fi

  rm -f "$DOCKER_COMPOSE_FILE_GENERATED"
  remove_orphan_managed_containers
  remove_existing_desired_containers
  remove_orphan_agent_homes
}

start_device_pairing_autoapprove() {
  local container="$1"
  local duration_seconds="$2"
  [[ "$duration_seconds" =~ ^[0-9]+$ ]] || return 0
  ((duration_seconds > 0)) || return 0

  local log_file="/tmp/${container}-device-autoapprove.log"
  nohup bash -lc "
    set -euo pipefail
    deadline=\$((SECONDS + ${duration_seconds}))
    while (( SECONDS < deadline )); do
      docker exec '${container}' sh -lc 'openclaw devices approve --latest --json >/dev/null 2>&1 || true' >/dev/null 2>&1 || true
      sleep 1
    done
  " >"$log_file" 2>&1 &
}

wait_for_ui() {
  local host_port="$1"
  local container="$2"
  local waited=0

  while true; do
    if curl -fsS --max-time 2 "http://127.0.0.1:${host_port}/" >/dev/null 2>&1; then
      return 0
    fi
    if docker exec "$container" sh -lc "curl -fsS --max-time 2 http://127.0.0.1:18789/ >/dev/null 2>&1"; then
      return 0
    fi

    waited=$((waited + 1))
    if [[ "$waited" -ge "$WAIT_TIMEOUT_SECONDS" ]]; then
      docker logs --tail 80 "$container" >&2 || true
      fail "UI readiness timeout for ${container} on host port ${host_port}"
    fi
    sleep 1
  done
}

require_http_ok() {
  local url="$1"
  local label="$2"
  curl -fsS --max-time 5 "$url" >/dev/null 2>&1 || fail "${label} check failed: ${url}"
}

validate_public_web_fetch_url() {
  [[ -n "$PUBLIC_SITE_BASE_URL" ]] || return 0

  local status_code
  status_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$WEB_FETCH_SKILL_URL" || true)"
  if [[ ! "$status_code" =~ ^2[0-9][0-9]$ ]]; then
    fail "PUBLIC_SITE_BASE_URL validation failed for WEB_FETCH_SKILL_URL=${WEB_FETCH_SKILL_URL} (status=${status_code:-unknown}). localtunnel can reject bot fetches with HTTP 400; provide a public /skill.md URL that returns 2xx."
  fi
}

require_container_http_ok() {
  local container="$1"
  local url="$2"
  local label="$3"
  docker exec "$container" sh -lc "curl -fsS --max-time 5 '$url' >/dev/null 2>&1" || fail "${label} check failed in ${container}: ${url}"
}

require_registry_groups_route_host() {
  local base_url="$1"
  local url="${base_url%/}/v1/groups"
  local status_code
  status_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 -X POST "$url" -H 'content-type: application/json' --data '{}')"
  if [[ "$status_code" == "404" ]]; then
    fail "registry groups route check failed: ${url} returned 404"
  fi
}

require_registry_groups_route_container() {
  local container="$1"
  local base_url="$2"
  local url="${base_url%/}/v1/groups"
  local status_code
  status_code="$(docker exec "$container" sh -lc "curl -sS -o /dev/null -w '%{http_code}' --max-time 5 -X POST '$url' -H 'content-type: application/json' --data '{}'" )"
  if [[ "$status_code" == "404" ]]; then
    fail "registry groups route check failed in ${container}: ${url} returned 404"
  fi
}

verify_host_stack_dependencies() {
  [[ "$VERIFY_STACK_DEPENDENCIES" == "1" ]] || return 0

  require_http_ok "${HOST_REGISTRY_URL%/}/health" "registry health"
  require_http_ok "${HOST_PROXY_URL%/}/health" "proxy health"
  require_http_ok "${HOST_SITE_BASE_URL%/}/skill.md" "landing skill"

  if [[ "$REQUIRE_APP_REGISTRY_GROUPS_ROUTE" == "1" ]]; then
    require_registry_groups_route_host "$HOST_REGISTRY_URL"
  fi
}

verify_container_stack_dependencies() {
  [[ "$VERIFY_STACK_DEPENDENCIES" == "1" ]] || return 0

  local idx container
  for idx in "${!AGENT_IDS[@]}"; do
    container="${AGENT_CONTAINERS[$idx]}"
    require_container_http_ok "$container" "${DOCKER_REGISTRY_URL%/}/health" "registry health"
    require_container_http_ok "$container" "${DOCKER_PROXY_URL%/}/health" "proxy health"
    require_container_http_ok "$container" "${DOCKER_SITE_BASE_URL%/}/skill.md" "landing skill"

    if [[ "$REQUIRE_APP_REGISTRY_GROUPS_ROUTE" == "1" ]]; then
      require_registry_groups_route_container "$container" "$DOCKER_REGISTRY_URL"
    fi
  done
}

validate_poststart_cleanup_state() {
  local existing
  while IFS= read -r existing; do
    [[ -n "$existing" ]] || continue
    if [[ -z "${DESIRED_CONTAINER_SET[$existing]:-}" ]]; then
      fail "Unexpected orphan managed container remains after startup: $existing"
    fi
  done < <(docker ps -a --format '{{.Names}}' | rg '^clawdbot-agent-' -N || true)
}

print_summary() {
  local idx home env_file token

  echo "generated_compose=$DOCKER_COMPOSE_FILE_GENERATED"
  echo "agent_count=${#AGENT_IDS[@]}"
  echo "prune_orphan_agent_homes=$PRUNE_ORPHAN_AGENT_HOMES"
  echo "cleanup_stack_down_ran=$PRESTART_STACK_DOWN_RAN"
  echo "cleanup_orphan_containers_removed=${#REMOVED_ORPHAN_CONTAINERS[@]}"
  echo "cleanup_reset_containers_removed=${#REMOVED_DESIRED_CONTAINERS[@]}"
  echo "cleanup_orphan_homes_pruned=${#PRUNED_ORPHAN_HOMES[@]}"
  echo "cleanup_agent_homes_reset=${#RESET_AGENT_HOMES[@]}"
  echo "model_primary=${OPENCLAW_MODEL}"
  echo "model_fallback=${OPENCLAW_FALLBACK_MODEL}"
  echo "web_fetch_skill_url=${WEB_FETCH_SKILL_URL}"
  if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    echo "openrouter_key_configured=1"
  else
    echo "openrouter_key_configured=0"
  fi

  for idx in "${!REMOVED_ORPHAN_CONTAINERS[@]}"; do
    echo "cleanup_orphan_container_${idx}=${REMOVED_ORPHAN_CONTAINERS[$idx]}"
  done
  for idx in "${!REMOVED_DESIRED_CONTAINERS[@]}"; do
    echo "cleanup_reset_container_${idx}=${REMOVED_DESIRED_CONTAINERS[$idx]}"
  done
  for idx in "${!PRUNED_ORPHAN_HOMES[@]}"; do
    echo "cleanup_orphan_home_${idx}=${PRUNED_ORPHAN_HOMES[$idx]}"
  done

  for idx in "${!AGENT_IDS[@]}"; do
    home="${AGENT_HOMES[$idx]}"
    env_file="$home/.env"
    token=""
    if [[ -f "$env_file" ]]; then
      token="$(awk -F= '$1=="OPENCLAW_GATEWAY_TOKEN"{print substr($0, index($0, "=")+1); exit}' "$env_file" | tr -d '"' | tr -d '[:space:]')"
    fi

    echo "agent_${idx}_id=${AGENT_IDS[$idx]}"
    echo "agent_${idx}_container=${AGENT_CONTAINERS[$idx]}"
    echo "agent_${idx}_home=${AGENT_HOMES[$idx]}"
    echo "agent_${idx}_expected_name=${AGENT_EXPECTED_NAMES[$idx]}"
    echo "agent_${idx}_ui_port=${AGENT_UI_PORTS[$idx]}"
    echo "agent_${idx}_api_port=${AGENT_API_PORTS[$idx]}"
    if [[ -n "$token" ]]; then
      echo "agent_${idx}_url=http://127.0.0.1:${AGENT_UI_PORTS[$idx]}/#token=${token}"
    fi
  done
}

run() {
  require_command rsync
  require_command rg
  require_command node
  require_command curl

  require_dir "$OPENCLAW_PERSONALITY_SOURCE_HOME"
  require_file "$OPENCLAW_PERSONALITY_SOURCE_HOME/openclaw.json"
  require_file "$LOCAL_OPENCLAW_POLICY_FILE"
  require_file "$LOCAL_EXEC_APPROVALS_FILE"

  normalize_agent_ids "$OPENCLAW_AGENT_IDS"
  build_agent_matrix
  validate_public_web_fetch_url
  verify_host_stack_dependencies

  if [[ "$OPENCLAW_SCALER_VALIDATE_ONLY" == "1" ]]; then
    generate_compose_file
    log "Validation-only mode complete"
    print_summary
    exit 0
  fi

  require_command docker

  prestart_cleanup
  prepare_agent_profiles
  generate_compose_file

  log "Starting generated OpenClaw stack"
  compose_generated up -d

  local idx
  for idx in "${!AGENT_IDS[@]}"; do
    wait_for_ui "${AGENT_UI_PORTS[$idx]}" "${AGENT_CONTAINERS[$idx]}"
    start_device_pairing_autoapprove "${AGENT_CONTAINERS[$idx]}" "$DEVICE_AUTO_APPROVE_SECONDS"
  done

  verify_container_stack_dependencies
  validate_poststart_cleanup_state
  print_summary

  log "Ready state complete"
}

run
