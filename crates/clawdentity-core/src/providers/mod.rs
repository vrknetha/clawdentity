pub mod nanobot;
pub mod nanoclaw;
pub mod openclaw;
pub mod picoclaw;

pub use nanobot::NanobotProvider;
pub use nanoclaw::NanoclawProvider;
pub use openclaw::OpenclawProvider;
pub use picoclaw::PicoclawProvider;

use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::config::{ConfigPathOptions, get_config_dir};
use crate::error::{CoreError, Result};
use crate::http::blocking_client;

pub trait PlatformProvider {
    /// Provider name (e.g., "openclaw", "picoclaw", "nanobot", "nanoclaw")
    fn name(&self) -> &str;

    /// Human-readable display name
    fn display_name(&self) -> &str;

    /// Detect if this platform is installed on the current system
    fn detect(&self) -> DetectionResult;

    /// Format an inbound message for this platform's webhook
    fn format_inbound(&self, message: &InboundMessage) -> InboundRequest;

    /// Get the platform's default webhook port
    fn default_webhook_port(&self) -> u16;

    /// Get the platform's default webhook host
    fn default_webhook_host(&self) -> &str {
        "127.0.0.1"
    }

    /// Get config file path for this platform
    fn config_path(&self) -> Option<PathBuf>;

    /// Install/configure the webhook channel for this platform
    fn install(&self, opts: &InstallOptions) -> Result<InstallResult>;

    /// Verify the installation is working
    fn verify(&self, opts: &VerifyOptions) -> Result<VerifyResult>;

    /// Run provider-specific diagnostics.
    fn doctor(&self, opts: &ProviderDoctorOptions) -> Result<ProviderDoctorResult>;

    /// Persist provider-specific relay setup.
    fn setup(&self, opts: &ProviderSetupOptions) -> Result<ProviderSetupResult>;

    /// Send a provider-specific relay probe to validate webhook delivery.
    fn relay_test(&self, opts: &ProviderRelayTestOptions) -> Result<ProviderRelayTestResult>;
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DetectionResult {
    pub detected: bool,
    pub confidence: f32,
    pub evidence: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InboundMessage {
    pub sender_did: String,
    pub recipient_did: String,
    pub content: String,
    pub request_id: Option<String>,
    pub metadata: HashMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InboundRequest {
    pub headers: HashMap<String, String>,
    pub body: Value,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallOptions {
    pub home_dir: Option<PathBuf>,
    pub webhook_port: Option<u16>,
    pub webhook_host: Option<String>,
    pub webhook_token: Option<String>,
    pub connector_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallResult {
    pub platform: String,
    pub config_updated: bool,
    pub service_installed: bool,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerifyResult {
    pub healthy: bool,
    pub checks: Vec<(String, bool, String)>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyOptions {
    pub home_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDoctorOptions {
    pub home_dir: Option<PathBuf>,
    pub platform_state_dir: Option<PathBuf>,
    pub selected_agent: Option<String>,
    pub peer_alias: Option<String>,
    pub connector_base_url: Option<String>,
    pub include_connector_runtime_check: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderDoctorCheckStatus {
    Pass,
    Warn,
    Fail,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderDoctorStatus {
    Healthy,
    Unhealthy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDoctorCheck {
    pub id: String,
    pub label: String,
    pub status: ProviderDoctorCheckStatus,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remediation_hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDoctorResult {
    pub platform: String,
    pub status: ProviderDoctorStatus,
    pub checks: Vec<ProviderDoctorCheck>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSetupOptions {
    pub home_dir: Option<PathBuf>,
    pub agent_name: Option<String>,
    pub openclaw_agent_id: Option<String>,
    pub platform_base_url: Option<String>,
    pub webhook_host: Option<String>,
    pub webhook_port: Option<u16>,
    pub webhook_token: Option<String>,
    pub connector_base_url: Option<String>,
    pub connector_url: Option<String>,
    pub relay_transform_peers_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSetupResult {
    pub platform: String,
    pub status: ProviderSetupStatus,
    pub notes: Vec<String>,
    pub updated_paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderSetupStatus {
    Ready,
    ActionRequired,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRelayTestOptions {
    pub home_dir: Option<PathBuf>,
    pub platform_state_dir: Option<PathBuf>,
    pub peer_alias: Option<String>,
    pub platform_base_url: Option<String>,
    pub webhook_token: Option<String>,
    pub connector_base_url: Option<String>,
    pub message: Option<String>,
    pub session_id: Option<String>,
    pub skip_preflight: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderRelayTestStatus {
    Success,
    Failure,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRelayTestResult {
    pub platform: String,
    pub status: ProviderRelayTestStatus,
    pub checked_at: String,
    pub endpoint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peer_alias: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remediation_hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preflight: Option<ProviderDoctorResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

/// TODO(clawdentity): document `all_providers`.
pub fn all_providers() -> Vec<Box<dyn PlatformProvider>> {
    vec![
        Box::new(OpenclawProvider::default()),
        Box::new(PicoclawProvider::default()),
        Box::new(NanobotProvider::default()),
        Box::new(NanoclawProvider::default()),
    ]
}

/// TODO(clawdentity): document `detect_platform`.
pub fn detect_platform() -> Option<Box<dyn PlatformProvider>> {
    let mut selected: Option<(f32, Box<dyn PlatformProvider>)> = None;

    for provider in all_providers() {
        let detection = provider.detect();
        if !detection.detected {
            continue;
        }

        if let Some((confidence, _)) = selected.as_ref()
            && detection.confidence <= *confidence
        {
            continue;
        }

        selected = Some((detection.confidence, provider));
    }

    selected.map(|(_, provider)| provider)
}

/// TODO(clawdentity): document `get_provider`.
pub fn get_provider(name: &str) -> Option<Box<dyn PlatformProvider>> {
    let normalized = name.trim();
    if normalized.is_empty() {
        return None;
    }

    all_providers()
        .into_iter()
        .find(|provider| provider.name().eq_ignore_ascii_case(normalized))
}

pub(crate) fn resolve_home_dir(home_override: Option<&Path>) -> Result<PathBuf> {
    if let Some(home_dir) = home_override {
        return Ok(home_dir.to_path_buf());
    }
    dirs::home_dir().ok_or(CoreError::HomeDirectoryUnavailable)
}

pub(crate) fn resolve_home_dir_with_fallback(
    install_override: Option<&Path>,
    provider_override: Option<&Path>,
) -> Result<PathBuf> {
    if let Some(home_dir) = install_override {
        return Ok(home_dir.to_path_buf());
    }

    resolve_home_dir(provider_override)
}

pub(crate) fn command_exists(command: &str, path_override: Option<&[PathBuf]>) -> bool {
    resolve_command_path(command, path_override).is_some()
}

pub(crate) fn resolve_command_path(
    command: &str,
    path_override: Option<&[PathBuf]>,
) -> Option<PathBuf> {
    if command.trim().is_empty() {
        return None;
    }

    if let Some(paths) = path_override {
        return paths
            .iter()
            .find_map(|path| command_path_in_directory(path, command));
    }

    match env::var_os("PATH") {
        Some(paths) => {
            env::split_paths(&paths).find_map(|path| command_path_in_directory(&path, command))
        }
        None => None,
    }
}

fn command_path_in_directory(path: &Path, command: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        if Path::new(command).extension().is_some() {
            let candidate = path.join(command);
            return candidate.is_file().then_some(candidate);
        }

        if let Some(pathext) = env::var_os("PATHEXT") {
            for ext in
                env::split_paths(&pathext).filter_map(|entry| entry.to_str().map(str::to_string))
            {
                let normalized = ext.trim_start_matches('.');
                let candidate = path.join(format!("{command}.{normalized}"));
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }

        let candidate = path.join(command);
        candidate.is_file().then_some(candidate)
    }

    #[cfg(not(windows))]
    {
        let candidate = path.join(command);
        candidate.is_file().then_some(candidate)
    }
}

pub(crate) fn default_webhook_url(host: &str, port: u16, webhook_path: &str) -> Result<String> {
    let host = host.trim();
    if host.is_empty() {
        return Err(CoreError::InvalidInput(
            "webhook host cannot be empty".to_string(),
        ));
    }

    let base_url = format!("http://{host}:{port}");
    join_url_path(&base_url, webhook_path, "webhookHost")
}

pub(crate) fn join_url_path(base_url: &str, path: &str, context: &'static str) -> Result<String> {
    let trimmed_base = base_url.trim();
    if trimmed_base.is_empty() {
        return Err(CoreError::InvalidInput(format!(
            "{context} cannot be empty"
        )));
    }

    let normalized_base = if trimmed_base.ends_with('/') {
        trimmed_base.to_string()
    } else {
        format!("{trimmed_base}/")
    };

    let url = url::Url::parse(&normalized_base).map_err(|_| CoreError::InvalidUrl {
        context,
        value: trimmed_base.to_string(),
    })?;

    let normalized_path = path.trim().trim_start_matches('/');
    let joined = url
        .join(normalized_path)
        .map_err(|_| CoreError::InvalidUrl {
            context,
            value: path.to_string(),
        })?;

    Ok(joined.to_string())
}

pub(crate) fn health_check(host: &str, port: u16) -> Result<(bool, String)> {
    let url = default_webhook_url(host, port, "/health")?;

    let response = blocking_client()?
        .get(&url)
        .header("accept", "application/json")
        .send();

    match response {
        Ok(response) => {
            if response.status().is_success() {
                Ok((
                    true,
                    format!("health endpoint responded with HTTP {}", response.status()),
                ))
            } else {
                Ok((
                    false,
                    format!("health endpoint returned HTTP {}", response.status()),
                ))
            }
        }
        Err(error) => Ok((false, format!("health endpoint request failed: {error}"))),
    }
}

pub(crate) fn read_json_or_default(path: &Path) -> Result<Value> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Ok(Value::Object(Map::new()));
        }
        Err(source) => {
            return Err(CoreError::Io {
                path: path.to_path_buf(),
                source,
            });
        }
    };

    if raw.trim().is_empty() {
        return Ok(Value::Object(Map::new()));
    }

    serde_json::from_str::<Value>(&raw).map_err(|source| CoreError::JsonParse {
        path: path.to_path_buf(),
        source,
    })
}

pub(crate) fn write_json(path: &Path, value: &Value) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|source| CoreError::Io {
            path: parent.to_path_buf(),
            source,
        })?;
    }

    let body = serde_json::to_string_pretty(value)?;
    fs::write(path, format!("{body}\n")).map_err(|source| CoreError::Io {
        path: path.to_path_buf(),
        source,
    })
}

pub(crate) fn read_text(path: &Path) -> Result<Option<String>> {
    match fs::read_to_string(path) {
        Ok(contents) => Ok(Some(contents)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(source) => Err(CoreError::Io {
            path: path.to_path_buf(),
            source,
        }),
    }
}

pub(crate) fn write_text(path: &Path, contents: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|source| CoreError::Io {
            path: parent.to_path_buf(),
            source,
        })?;
    }

    fs::write(path, contents).map_err(|source| CoreError::Io {
        path: path.to_path_buf(),
        source,
    })
}

pub(crate) fn ensure_json_object_path<'a>(
    root: &'a mut Value,
    path: &[&str],
) -> Result<&'a mut Map<String, Value>> {
    if !root.is_object() {
        *root = Value::Object(Map::new());
    }

    let mut current = root;
    for segment in path {
        if !current.is_object() {
            *current = Value::Object(Map::new());
        }

        let object = current
            .as_object_mut()
            .ok_or_else(|| CoreError::InvalidInput("json value must be an object".to_string()))?;

        current = object
            .entry((*segment).to_string())
            .or_insert_with(|| Value::Object(Map::new()));
    }

    if !current.is_object() {
        *current = Value::Object(Map::new());
    }

    current
        .as_object_mut()
        .ok_or_else(|| CoreError::InvalidInput("json value must be an object".to_string()))
}

pub(crate) fn upsert_env_var(contents: &str, key: &str, value: &str) -> String {
    let mut updated = false;
    let mut lines = Vec::new();

    for line in contents.lines() {
        if let Some((line_key, _)) = line.split_once('=')
            && line_key.trim() == key
        {
            lines.push(format!("{key}={value}"));
            updated = true;
            continue;
        }

        lines.push(line.to_string());
    }

    if !updated {
        if !contents.trim().is_empty() {
            lines.push(String::new());
        }
        lines.push(format!("{key}={value}"));
    }

    let mut output = lines.join("\n");
    if !output.ends_with('\n') {
        output.push('\n');
    }
    output
}

pub(crate) fn upsert_marked_block(contents: &str, start: &str, end: &str, block: &str) -> String {
    if let Some(start_idx) = contents.find(start)
        && let Some(end_rel_idx) = contents[start_idx..].find(end)
    {
        let end_idx = start_idx + end_rel_idx + end.len();

        let prefix = contents[..start_idx].trim_end_matches('\n');
        let suffix = contents[end_idx..].trim_start_matches('\n');

        let mut output = String::new();
        if !prefix.is_empty() {
            output.push_str(prefix);
            output.push('\n');
        }
        output.push_str(block.trim_end_matches('\n'));
        output.push('\n');
        if !suffix.is_empty() {
            output.push_str(suffix);
            if !output.ends_with('\n') {
                output.push('\n');
            }
        }
        return output;
    }

    let mut output = contents.trim_end_matches('\n').to_string();
    if !output.is_empty() {
        output.push('\n');
    }
    output.push_str(block.trim_end_matches('\n'));
    output.push('\n');
    output
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderRelayRuntimeConfig {
    pub webhook_endpoint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connector_base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub webhook_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platform_base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relay_transform_peers_path: Option<String>,
    pub updated_at: String,
}

pub(crate) fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub(crate) fn resolve_state_dir(home_dir: Option<PathBuf>) -> Result<PathBuf> {
    let options = ConfigPathOptions {
        home_dir,
        registry_url_hint: None,
    };
    get_config_dir(&options)
}

pub(crate) fn provider_agent_marker_path(state_dir: &Path, provider: &str) -> PathBuf {
    state_dir.join(format!("{provider}-agent-name"))
}

pub(crate) fn provider_runtime_path(state_dir: &Path, provider: &str) -> PathBuf {
    state_dir.join(format!("{provider}-relay.json"))
}

pub(crate) fn write_provider_agent_marker(
    state_dir: &Path,
    provider: &str,
    agent_name: &str,
) -> Result<PathBuf> {
    let agent_name = agent_name.trim();
    if agent_name.is_empty() {
        return Err(CoreError::InvalidInput(
            "agent name cannot be empty".to_string(),
        ));
    }
    let path = provider_agent_marker_path(state_dir, provider);
    write_text(&path, &format!("{agent_name}\n"))?;
    Ok(path)
}

pub(crate) fn read_provider_agent_marker(
    state_dir: &Path,
    provider: &str,
) -> Result<Option<String>> {
    let path = provider_agent_marker_path(state_dir, provider);
    let value = read_text(&path)?;
    Ok(value.and_then(|value| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    }))
}

pub(crate) fn save_provider_runtime_config(
    state_dir: &Path,
    provider: &str,
    config: ProviderRelayRuntimeConfig,
) -> Result<PathBuf> {
    let path = provider_runtime_path(state_dir, provider);
    let mut value = serde_json::to_value(&config)?;
    if !value.is_object() {
        value = Value::Object(Map::new());
    }
    write_json(&path, &value)?;
    Ok(path)
}

pub(crate) fn load_provider_runtime_config(
    state_dir: &Path,
    provider: &str,
) -> Result<Option<ProviderRelayRuntimeConfig>> {
    let path = provider_runtime_path(state_dir, provider);
    let value = match read_text(&path)? {
        Some(raw) => {
            if raw.trim().is_empty() {
                return Ok(None);
            }
            serde_json::from_str::<ProviderRelayRuntimeConfig>(&raw).map_err(|source| {
                CoreError::JsonParse {
                    path: path.clone(),
                    source,
                }
            })?
        }
        None => return Ok(None),
    };
    Ok(Some(value))
}

pub(crate) fn push_doctor_check(
    checks: &mut Vec<ProviderDoctorCheck>,
    id: impl Into<String>,
    label: impl Into<String>,
    status: ProviderDoctorCheckStatus,
    message: impl Into<String>,
    remediation_hint: Option<String>,
    details: Option<Value>,
) {
    checks.push(ProviderDoctorCheck {
        id: id.into(),
        label: label.into(),
        status,
        message: message.into(),
        remediation_hint,
        details,
    });
}

pub(crate) fn doctor_status_from_checks(checks: &[ProviderDoctorCheck]) -> ProviderDoctorStatus {
    if checks
        .iter()
        .any(|check| check.status == ProviderDoctorCheckStatus::Fail)
    {
        ProviderDoctorStatus::Unhealthy
    } else {
        ProviderDoctorStatus::Healthy
    }
}

pub(crate) fn check_connector_runtime(connector_base_url: &str) -> Result<(bool, String)> {
    let status_url = join_url_path(connector_base_url, "/v1/status", "connectorBaseUrl")?;
    let response = blocking_client()?
        .get(&status_url)
        .header("accept", "application/json")
        .send();

    let response = match response {
        Ok(response) => response,
        Err(error) => {
            return Ok((false, format!("connector status request failed: {error}")));
        }
    };

    if !response.status().is_success() {
        return Ok((
            false,
            format!("connector status returned HTTP {}", response.status()),
        ));
    }

    let payload: Value = response
        .json()
        .map_err(|error| CoreError::Http(error.to_string()))?;
    let connected = payload
        .get("websocket")
        .and_then(|value| value.get("connected"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if connected {
        Ok((true, "connector websocket is connected".to_string()))
    } else {
        Ok((false, "connector websocket is disconnected".to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::{all_providers, get_provider};

    #[test]
    fn provider_registry_has_expected_platforms() {
        let names = all_providers()
            .into_iter()
            .map(|provider| provider.name().to_string())
            .collect::<Vec<_>>();

        assert_eq!(names, vec!["openclaw", "picoclaw", "nanobot", "nanoclaw"]);
    }

    #[test]
    fn get_provider_matches_name_case_insensitively() {
        assert_eq!(
            get_provider("PicoClaw").map(|provider| provider.name().to_string()),
            Some("picoclaw".to_string())
        );
    }
}
