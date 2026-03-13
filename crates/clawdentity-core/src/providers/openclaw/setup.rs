use std::collections::BTreeMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, Result};

pub const OPENCLAW_AGENT_FILE_NAME: &str = "openclaw-agent-name";
pub const OPENCLAW_RELAY_RUNTIME_FILE_NAME: &str = "openclaw-relay.json";
pub const OPENCLAW_CONNECTORS_FILE_NAME: &str = "openclaw-connectors.json";
pub const OPENCLAW_CONFIG_FILE_NAME: &str = "openclaw.json";
pub const OPENCLAW_DEFAULT_BASE_URL: &str = "http://127.0.0.1:18789";
pub const DEFAULT_CONNECTOR_PORT: u16 = 19400;

const FILE_MODE: u32 = 0o600;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenclawRelayRuntimeConfig {
    pub openclaw_base_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub openclaw_hook_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relay_transform_peers_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenclawConnectorAssignment {
    pub connector_base_url: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenclawConnectorsConfig {
    pub agents: BTreeMap<String, OpenclawConnectorAssignment>,
}

fn parse_non_empty(value: &str, field: &str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(CoreError::InvalidInput(format!("{field} is required")));
    }
    Ok(trimmed.to_string())
}

fn normalize_http_url(value: &str, field: &'static str) -> Result<String> {
    let parsed = url::Url::parse(value.trim()).map_err(|_| CoreError::InvalidUrl {
        context: field,
        value: value.to_string(),
    })?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(CoreError::InvalidUrl {
            context: field,
            value: value.to_string(),
        });
    }
    Ok(parsed.to_string())
}

fn write_secure_text(path: &Path, content: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|source| CoreError::Io {
            path: parent.to_path_buf(),
            source,
        })?;
    }
    fs::write(path, content).map_err(|source| CoreError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(FILE_MODE)).map_err(|source| {
            CoreError::Io {
                path: path.to_path_buf(),
                source,
            }
        })?;
    }
    Ok(())
}

fn write_secure_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let body = serde_json::to_string_pretty(value)?;
    write_secure_text(path, &format!("{body}\n"))
}

fn read_json_if_exists<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Option<T>> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(CoreError::Io {
                path: path.to_path_buf(),
                source,
            });
        }
    };
    let parsed = serde_json::from_str::<T>(&raw).map_err(|source| CoreError::JsonParse {
        path: path.to_path_buf(),
        source,
    })?;
    Ok(Some(parsed))
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn env_first_non_empty(keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        std::env::var(key).ok().and_then(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        })
    })
}

fn resolve_fallback_home_dir(home_dir: Option<&Path>) -> Result<PathBuf> {
    if let Some(home_dir) = home_dir {
        return Ok(home_dir.to_path_buf());
    }
    dirs::home_dir().ok_or(CoreError::HomeDirectoryUnavailable)
}

fn uses_direct_openclaw_profile(home_dir: &Path) -> bool {
    home_dir.ends_with(".openclaw")
        || home_dir.join(OPENCLAW_CONFIG_FILE_NAME).is_file()
        || home_dir.join("hooks").is_dir()
        || home_dir.join("skills").is_dir()
        || home_dir.join("devices").is_dir()
}

pub(super) fn explicit_openclaw_dir(home_dir: &Path) -> PathBuf {
    if uses_direct_openclaw_profile(home_dir) {
        home_dir.to_path_buf()
    } else {
        home_dir.join(".openclaw")
    }
}

pub(super) fn explicit_openclaw_config_path(home_dir: &Path) -> PathBuf {
    explicit_openclaw_dir(home_dir).join(OPENCLAW_CONFIG_FILE_NAME)
}

/// TODO(clawdentity): document `resolve_openclaw_dir`.
pub fn resolve_openclaw_dir(
    home_dir: Option<&Path>,
    override_dir: Option<&Path>,
) -> Result<PathBuf> {
    if let Some(path) = override_dir {
        return Ok(path.to_path_buf());
    }

    if let Some(home_dir) = home_dir {
        return Ok(explicit_openclaw_dir(home_dir));
    }

    if let Some(path) = env_first_non_empty(&["OPENCLAW_STATE_DIR", "CLAWDBOT_STATE_DIR"]) {
        return Ok(PathBuf::from(path));
    }

    if let Some(path) = env_first_non_empty(&["OPENCLAW_CONFIG_PATH", "CLAWDBOT_CONFIG_PATH"]) {
        let path = PathBuf::from(path);
        return Ok(path.parent().map(Path::to_path_buf).unwrap_or(path));
    }

    if let Some(path) = env_first_non_empty(&["OPENCLAW_HOME"]) {
        return Ok(PathBuf::from(path).join(".openclaw"));
    }

    Ok(resolve_fallback_home_dir(home_dir)?.join(".openclaw"))
}

/// TODO(clawdentity): document `resolve_openclaw_config_path`.
pub fn resolve_openclaw_config_path(
    home_dir: Option<&Path>,
    override_dir: Option<&Path>,
) -> Result<PathBuf> {
    if let Some(home_dir) = home_dir {
        return Ok(explicit_openclaw_config_path(home_dir));
    }

    if let Some(path) = env_first_non_empty(&["OPENCLAW_CONFIG_PATH", "CLAWDBOT_CONFIG_PATH"]) {
        return Ok(PathBuf::from(path));
    }

    Ok(resolve_openclaw_dir(home_dir, override_dir)?.join(OPENCLAW_CONFIG_FILE_NAME))
}

/// TODO(clawdentity): document `openclaw_agent_name_path`.
pub fn openclaw_agent_name_path(config_dir: &Path) -> PathBuf {
    config_dir.join(OPENCLAW_AGENT_FILE_NAME)
}

/// TODO(clawdentity): document `openclaw_relay_runtime_path`.
pub fn openclaw_relay_runtime_path(config_dir: &Path) -> PathBuf {
    config_dir.join(OPENCLAW_RELAY_RUNTIME_FILE_NAME)
}

/// TODO(clawdentity): document `openclaw_connectors_path`.
pub fn openclaw_connectors_path(config_dir: &Path) -> PathBuf {
    config_dir.join(OPENCLAW_CONNECTORS_FILE_NAME)
}

/// TODO(clawdentity): document `read_selected_openclaw_agent`.
pub fn read_selected_openclaw_agent(config_dir: &Path) -> Result<Option<String>> {
    let path = openclaw_agent_name_path(config_dir);
    let value = match fs::read_to_string(&path) {
        Ok(value) => value,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(source) => return Err(CoreError::Io { path, source }),
    };
    let selected = value.trim().to_string();
    if selected.is_empty() {
        return Ok(None);
    }
    Ok(Some(selected))
}

/// TODO(clawdentity): document `write_selected_openclaw_agent`.
pub fn write_selected_openclaw_agent(config_dir: &Path, agent_name: &str) -> Result<PathBuf> {
    let selected = parse_non_empty(agent_name, "agentName")?;
    let path = openclaw_agent_name_path(config_dir);
    write_secure_text(&path, &format!("{selected}\n"))?;
    Ok(path)
}

/// TODO(clawdentity): document `load_relay_runtime_config`.
pub fn load_relay_runtime_config(config_dir: &Path) -> Result<Option<OpenclawRelayRuntimeConfig>> {
    read_json_if_exists::<OpenclawRelayRuntimeConfig>(&openclaw_relay_runtime_path(config_dir))
}

/// TODO(clawdentity): document `save_relay_runtime_config`.
pub fn save_relay_runtime_config(
    config_dir: &Path,
    config: OpenclawRelayRuntimeConfig,
) -> Result<PathBuf> {
    let normalized = OpenclawRelayRuntimeConfig {
        openclaw_base_url: normalize_http_url(&config.openclaw_base_url, "openclawBaseUrl")?,
        openclaw_hook_token: config
            .openclaw_hook_token
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        relay_transform_peers_path: config
            .relay_transform_peers_path
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        updated_at: config.updated_at.or_else(|| Some(now_iso())),
    };
    let path = openclaw_relay_runtime_path(config_dir);
    write_secure_json(&path, &normalized)?;
    Ok(path)
}

/// TODO(clawdentity): document `resolve_openclaw_base_url`.
pub fn resolve_openclaw_base_url(config_dir: &Path, option_value: Option<&str>) -> Result<String> {
    if let Some(value) = option_value
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return normalize_http_url(value, "openclawBaseUrl");
    }
    if let Ok(value) = std::env::var("OPENCLAW_BASE_URL") {
        let value = value.trim();
        if !value.is_empty() {
            return normalize_http_url(value, "openclawBaseUrl");
        }
    }
    if let Some(runtime) = load_relay_runtime_config(config_dir)? {
        return normalize_http_url(&runtime.openclaw_base_url, "openclawBaseUrl");
    }
    Ok(OPENCLAW_DEFAULT_BASE_URL.to_string())
}

/// TODO(clawdentity): document `resolve_openclaw_hook_token`.
pub fn resolve_openclaw_hook_token(
    config_dir: &Path,
    option_value: Option<&str>,
) -> Result<Option<String>> {
    if let Some(value) = option_value
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok(Some(value.to_string()));
    }
    if let Ok(value) = std::env::var("OPENCLAW_HOOK_TOKEN") {
        let value = value.trim();
        if !value.is_empty() {
            return Ok(Some(value.to_string()));
        }
    }
    Ok(load_relay_runtime_config(config_dir)?
        .and_then(|config| config.openclaw_hook_token)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty()))
}

/// TODO(clawdentity): document `load_connector_assignments`.
pub fn load_connector_assignments(config_dir: &Path) -> Result<OpenclawConnectorsConfig> {
    Ok(
        read_json_if_exists::<OpenclawConnectorsConfig>(&openclaw_connectors_path(config_dir))?
            .unwrap_or_default(),
    )
}

/// TODO(clawdentity): document `save_connector_assignment`.
pub fn save_connector_assignment(
    config_dir: &Path,
    agent_name: &str,
    connector_base_url: &str,
) -> Result<PathBuf> {
    let agent_name = parse_non_empty(agent_name, "agentName")?;
    let connector_base_url = normalize_http_url(connector_base_url, "connectorBaseUrl")?;
    let mut assignments = load_connector_assignments(config_dir)?;
    assignments.agents.insert(
        agent_name,
        OpenclawConnectorAssignment {
            connector_base_url,
            updated_at: now_iso(),
        },
    );
    let path = openclaw_connectors_path(config_dir);
    write_secure_json(&path, &assignments)?;
    Ok(path)
}

/// TODO(clawdentity): document `connector_port_from_base_url`.
pub fn connector_port_from_base_url(connector_base_url: &str) -> Option<u16> {
    let parsed = url::Url::parse(connector_base_url.trim()).ok()?;
    if let Some(port) = parsed.port() {
        return Some(port);
    }
    match parsed.scheme() {
        "https" => Some(443),
        "http" => Some(80),
        _ => None,
    }
}

/// TODO(clawdentity): document `build_connector_base_url`.
pub fn build_connector_base_url(host: &str, port: u16) -> String {
    format!("http://{host}:{port}")
}

fn allocate_connector_port(assignments: &OpenclawConnectorsConfig, agent_name: &str) -> u16 {
    if let Some(existing) = assignments.agents.get(agent_name) {
        if let Some(port) = connector_port_from_base_url(&existing.connector_base_url) {
            return port;
        }
    }

    let mut used_ports = assignments
        .agents
        .values()
        .filter_map(|entry| connector_port_from_base_url(&entry.connector_base_url))
        .collect::<Vec<_>>();
    used_ports.sort_unstable();
    used_ports.dedup();

    let mut candidate = DEFAULT_CONNECTOR_PORT;
    while used_ports.binary_search(&candidate).is_ok() {
        candidate += 1;
    }
    candidate
}

/// TODO(clawdentity): document `suggest_connector_base_url`.
pub fn suggest_connector_base_url(config_dir: &Path, agent_name: &str) -> Result<String> {
    let assignments = load_connector_assignments(config_dir)?;
    let port = allocate_connector_port(&assignments, agent_name);
    Ok(build_connector_base_url("127.0.0.1", port))
}

/// TODO(clawdentity): document `resolve_connector_base_url`.
pub fn resolve_connector_base_url(
    config_dir: &Path,
    agent_name: Option<&str>,
    override_base_url: Option<&str>,
) -> Result<Option<String>> {
    if let Some(value) = override_base_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok(Some(normalize_http_url(value, "connectorBaseUrl")?));
    }
    if let Ok(value) = std::env::var("CLAWDENTITY_CONNECTOR_BASE_URL") {
        let value = value.trim();
        if !value.is_empty() {
            return Ok(Some(normalize_http_url(value, "connectorBaseUrl")?));
        }
    }
    let Some(agent_name) = agent_name.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let assignments = load_connector_assignments(config_dir)?;
    Ok(assignments
        .agents
        .get(agent_name)
        .map(|entry| entry.connector_base_url.clone()))
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::{
        OPENCLAW_DEFAULT_BASE_URL, OpenclawRelayRuntimeConfig, build_connector_base_url,
        connector_port_from_base_url, load_connector_assignments, load_relay_runtime_config,
        read_selected_openclaw_agent, resolve_openclaw_base_url, resolve_openclaw_config_path,
        resolve_openclaw_dir, save_connector_assignment, save_relay_runtime_config,
        suggest_connector_base_url, write_selected_openclaw_agent,
    };

    #[test]
    fn selected_agent_round_trip() {
        let temp = TempDir::new().expect("temp dir");
        let _ = write_selected_openclaw_agent(temp.path(), "alpha").expect("write");
        let selected = read_selected_openclaw_agent(temp.path()).expect("read");
        assert_eq!(selected.as_deref(), Some("alpha"));
    }

    #[test]
    fn relay_runtime_config_round_trip() {
        let temp = TempDir::new().expect("temp dir");
        let _ = save_relay_runtime_config(
            temp.path(),
            OpenclawRelayRuntimeConfig {
                openclaw_base_url: "http://127.0.0.1:18789".to_string(),
                openclaw_hook_token: Some("hook-token".to_string()),
                relay_transform_peers_path: None,
                updated_at: None,
            },
        )
        .expect("save");
        let loaded = load_relay_runtime_config(temp.path())
            .expect("load")
            .expect("config");
        assert_eq!(loaded.openclaw_base_url, "http://127.0.0.1:18789/");
        assert_eq!(loaded.openclaw_hook_token.as_deref(), Some("hook-token"));
    }

    #[test]
    fn openclaw_base_url_defaults_when_runtime_config_is_missing() {
        let temp = TempDir::new().expect("temp dir");
        let resolved = resolve_openclaw_base_url(temp.path(), None).expect("base url");
        assert_eq!(resolved, OPENCLAW_DEFAULT_BASE_URL);
    }

    #[test]
    fn connector_assignments_round_trip() {
        let temp = TempDir::new().expect("temp dir");
        let _ = save_connector_assignment(temp.path(), "alpha", "http://127.0.0.1:19400")
            .expect("save");
        let assignments = load_connector_assignments(temp.path()).expect("load");
        assert_eq!(assignments.agents.len(), 1);
        assert_eq!(
            assignments
                .agents
                .get("alpha")
                .map(|entry| entry.connector_base_url.as_str()),
            Some("http://127.0.0.1:19400/")
        );
    }

    #[test]
    fn connector_port_helpers_round_trip() {
        assert_eq!(
            connector_port_from_base_url("http://127.0.0.1:19400"),
            Some(19400)
        );
        assert_eq!(
            build_connector_base_url("127.0.0.1", 19401),
            "http://127.0.0.1:19401"
        );
    }

    #[test]
    fn connector_suggestion_uses_next_available_port() {
        let temp = TempDir::new().expect("temp dir");
        let _ = save_connector_assignment(temp.path(), "alpha", "http://127.0.0.1:19400")
            .expect("save alpha");
        let suggested = suggest_connector_base_url(temp.path(), "beta").expect("suggest");
        assert_eq!(suggested, "http://127.0.0.1:19401");
    }

    #[test]
    fn openclaw_dir_respects_legacy_env_aliases() {
        let temp = TempDir::new().expect("temp dir");
        let state_dir = temp.path().join("legacy-state");
        let config_path = state_dir.join("clawdbot.custom.json");
        std::fs::create_dir_all(&state_dir).expect("state dir");

        unsafe {
            std::env::set_var("CLAWDBOT_STATE_DIR", &state_dir);
            std::env::set_var("CLAWDBOT_CONFIG_PATH", &config_path);
        }

        let resolved_dir = resolve_openclaw_dir(None, None).expect("dir");
        let resolved_config = resolve_openclaw_config_path(None, None).expect("config");

        unsafe {
            std::env::remove_var("CLAWDBOT_STATE_DIR");
            std::env::remove_var("CLAWDBOT_CONFIG_PATH");
        }

        assert_eq!(resolved_dir, state_dir);
        assert_eq!(resolved_config, config_path);
    }

    #[test]
    fn explicit_home_dir_beats_legacy_env_aliases() {
        let temp = TempDir::new().expect("temp dir");
        let state_dir = temp.path().join("legacy-state");
        let config_path = state_dir.join("clawdbot.custom.json");
        std::fs::create_dir_all(&state_dir).expect("state dir");

        unsafe {
            std::env::set_var("CLAWDBOT_STATE_DIR", &state_dir);
            std::env::set_var("CLAWDBOT_CONFIG_PATH", &config_path);
        }

        let resolved_dir = resolve_openclaw_dir(Some(temp.path()), None).expect("dir");
        let resolved_config =
            resolve_openclaw_config_path(Some(temp.path()), None).expect("config");

        unsafe {
            std::env::remove_var("CLAWDBOT_STATE_DIR");
            std::env::remove_var("CLAWDBOT_CONFIG_PATH");
        }

        assert_eq!(resolved_dir, temp.path().join(".openclaw"));
        assert_eq!(
            resolved_config,
            temp.path()
                .join(".openclaw")
                .join(super::OPENCLAW_CONFIG_FILE_NAME)
        );
    }

    #[test]
    fn explicit_home_dir_uses_direct_profile_root_when_openclaw_files_exist() {
        let temp = TempDir::new().expect("temp dir");
        std::fs::write(temp.path().join(super::OPENCLAW_CONFIG_FILE_NAME), "{}\n").expect("config");

        let resolved_dir = resolve_openclaw_dir(Some(temp.path()), None).expect("dir");
        let resolved_config =
            resolve_openclaw_config_path(Some(temp.path()), None).expect("config");

        assert_eq!(resolved_dir, temp.path());
        assert_eq!(
            resolved_config,
            temp.path().join(super::OPENCLAW_CONFIG_FILE_NAME)
        );
    }
}
