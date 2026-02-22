use std::collections::BTreeMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, Result};

pub const OPENCLAW_AGENT_FILE_NAME: &str = "openclaw-agent-name";
pub const OPENCLAW_RELAY_RUNTIME_FILE_NAME: &str = "openclaw-relay.json";
pub const OPENCLAW_CONNECTORS_FILE_NAME: &str = "openclaw-connectors.json";
pub const OPENCLAW_DEFAULT_BASE_URL: &str = "http://127.0.0.1:18789";

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenclawConnectorsConfig {
    pub agents: BTreeMap<String, OpenclawConnectorAssignment>,
}

impl Default for OpenclawConnectorsConfig {
    fn default() -> Self {
        Self {
            agents: BTreeMap::new(),
        }
    }
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

pub fn openclaw_agent_name_path(config_dir: &Path) -> PathBuf {
    config_dir.join(OPENCLAW_AGENT_FILE_NAME)
}

pub fn openclaw_relay_runtime_path(config_dir: &Path) -> PathBuf {
    config_dir.join(OPENCLAW_RELAY_RUNTIME_FILE_NAME)
}

pub fn openclaw_connectors_path(config_dir: &Path) -> PathBuf {
    config_dir.join(OPENCLAW_CONNECTORS_FILE_NAME)
}

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

pub fn write_selected_openclaw_agent(config_dir: &Path, agent_name: &str) -> Result<PathBuf> {
    let selected = parse_non_empty(agent_name, "agentName")?;
    let path = openclaw_agent_name_path(config_dir);
    write_secure_text(&path, &format!("{selected}\n"))?;
    Ok(path)
}

pub fn load_relay_runtime_config(config_dir: &Path) -> Result<Option<OpenclawRelayRuntimeConfig>> {
    read_json_if_exists::<OpenclawRelayRuntimeConfig>(&openclaw_relay_runtime_path(config_dir))
}

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

pub fn load_connector_assignments(config_dir: &Path) -> Result<OpenclawConnectorsConfig> {
    Ok(
        read_json_if_exists::<OpenclawConnectorsConfig>(&openclaw_connectors_path(config_dir))?
            .unwrap_or_default(),
    )
}

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
        OPENCLAW_DEFAULT_BASE_URL, OpenclawRelayRuntimeConfig, load_connector_assignments,
        load_relay_runtime_config, read_selected_openclaw_agent, resolve_openclaw_base_url,
        save_connector_assignment, save_relay_runtime_config, write_selected_openclaw_agent,
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
}
