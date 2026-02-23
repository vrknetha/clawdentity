use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::json;

use crate::config::{ConfigPathOptions, get_config_dir};
use crate::db::SqliteStore;
use crate::error::Result;
pub use self::doctor::{
    DoctorCheckStatus, DoctorStatus, OpenclawDoctorCheck, OpenclawDoctorOptions,
    OpenclawDoctorResult, run_openclaw_doctor,
};
pub use self::relay_test::{
    OpenclawRelayTestOptions, OpenclawRelayTestResult, OpenclawRelayWebsocketTestOptions,
    OpenclawRelayWebsocketTestResult, RelayCheckStatus, run_openclaw_relay_test,
    run_openclaw_relay_websocket_test,
};
pub use self::setup::{
    OPENCLAW_AGENT_FILE_NAME, OPENCLAW_CONNECTORS_FILE_NAME, OPENCLAW_DEFAULT_BASE_URL,
    OPENCLAW_RELAY_RUNTIME_FILE_NAME, OpenclawConnectorAssignment, OpenclawConnectorsConfig,
    OpenclawRelayRuntimeConfig, load_connector_assignments, load_relay_runtime_config,
    openclaw_agent_name_path, openclaw_connectors_path, openclaw_relay_runtime_path,
    read_selected_openclaw_agent, resolve_connector_base_url, resolve_openclaw_base_url,
    resolve_openclaw_hook_token, save_connector_assignment, save_relay_runtime_config,
    write_selected_openclaw_agent,
};
use crate::provider::{
    DetectionResult, InboundMessage, InboundRequest, InstallOptions, InstallResult,
    PlatformProvider, ProviderDoctorCheckStatus, ProviderDoctorOptions, ProviderDoctorResult,
    ProviderDoctorStatus, ProviderRelayTestOptions, ProviderRelayTestResult,
    ProviderRelayTestStatus, ProviderSetupOptions, ProviderSetupResult, VerifyResult,
    command_exists, default_webhook_url, ensure_json_object_path, join_url_path, now_iso,
    read_json_or_default, resolve_home_dir_with_fallback, write_json,
};

const PROVIDER_NAME: &str = "openclaw";
const PROVIDER_DISPLAY_NAME: &str = "OpenClaw";
const OPENCLAW_DIR_NAME: &str = ".openclaw";
const OPENCLAW_CONFIG_FILE_NAME: &str = "openclaw.json";
const OPENCLAW_BINARY: &str = "openclaw";
const OPENCLAW_WEBHOOK_PATH: &str = "/hooks/agent";

#[derive(Debug, Clone, Default)]
pub struct OpenclawProvider {
    home_dir_override: Option<PathBuf>,
    path_override: Option<Vec<PathBuf>>,
}

impl OpenclawProvider {
    fn resolve_home_dir(&self) -> Option<PathBuf> {
        self.home_dir_override.clone().or_else(dirs::home_dir)
    }

    fn openclaw_config_path_from_home(home_dir: &Path) -> PathBuf {
        home_dir
            .join(OPENCLAW_DIR_NAME)
            .join(OPENCLAW_CONFIG_FILE_NAME)
    }

    fn install_home_dir(&self, opts: &InstallOptions) -> Result<PathBuf> {
        resolve_home_dir_with_fallback(opts.home_dir.as_deref(), self.home_dir_override.as_deref())
    }

    fn resolve_webhook_url(&self, opts: &InstallOptions) -> Result<String> {
        if let Some(connector_url) = opts
            .connector_url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return join_url_path(connector_url, OPENCLAW_WEBHOOK_PATH, "connectorUrl");
        }

        let host = opts
            .webhook_host
            .as_deref()
            .unwrap_or(self.default_webhook_host());
        let port = opts.webhook_port.unwrap_or(self.default_webhook_port());
        default_webhook_url(host, port, OPENCLAW_WEBHOOK_PATH)
    }

    #[cfg(test)]
    fn with_test_context(home_dir: PathBuf, path_override: Vec<PathBuf>) -> Self {
        Self {
            home_dir_override: Some(home_dir),
            path_override: Some(path_override),
        }
    }
}

impl PlatformProvider for OpenclawProvider {
    fn name(&self) -> &str {
        PROVIDER_NAME
    }

    fn display_name(&self) -> &str {
        PROVIDER_DISPLAY_NAME
    }

    fn detect(&self) -> DetectionResult {
        let mut evidence = Vec::new();
        let mut confidence: f32 = 0.0;

        if let Some(home_dir) = self.resolve_home_dir() {
            let openclaw_dir = home_dir.join(OPENCLAW_DIR_NAME);
            if openclaw_dir.is_dir() {
                evidence.push(format!("found {}/", openclaw_dir.display()));
                confidence += 0.65;
            }

            let config_path = openclaw_dir.join(OPENCLAW_CONFIG_FILE_NAME);
            if config_path.is_file() {
                evidence.push(format!("found {}", config_path.display()));
                confidence += 0.1;
            }
        }

        if command_exists(OPENCLAW_BINARY, self.path_override.as_deref()) {
            evidence.push("openclaw binary in PATH".to_string());
            confidence += 0.35;
        }

        DetectionResult {
            detected: confidence > 0.0,
            confidence: confidence.min(1.0),
            evidence,
        }
    }

    fn format_inbound(&self, message: &InboundMessage) -> InboundRequest {
        let mut headers = HashMap::new();
        headers.insert(
            "x-webhook-sender-id".to_string(),
            message.sender_did.clone(),
        );
        headers.insert(
            "x-webhook-recipient-id".to_string(),
            message.recipient_did.clone(),
        );
        headers.insert(
            "x-webhook-target-path".to_string(),
            OPENCLAW_WEBHOOK_PATH.to_string(),
        );
        if let Some(request_id) = message
            .request_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            headers.insert("x-webhook-request-id".to_string(), request_id.to_string());
        }

        InboundRequest {
            headers,
            body: json!({
                "content": message.content,
                "senderDid": message.sender_did,
                "recipientDid": message.recipient_did,
                "requestId": message.request_id,
                "metadata": message.metadata,
                "path": OPENCLAW_WEBHOOK_PATH,
            }),
        }
    }

    fn default_webhook_port(&self) -> u16 {
        3001
    }

    fn config_path(&self) -> Option<PathBuf> {
        self.resolve_home_dir()
            .map(|home_dir| Self::openclaw_config_path_from_home(&home_dir))
    }

    fn install(&self, opts: &InstallOptions) -> Result<InstallResult> {
        let home_dir = self.install_home_dir(opts)?;
        let config_path = Self::openclaw_config_path_from_home(&home_dir);

        let state_options = ConfigPathOptions {
            home_dir: Some(home_dir.clone()),
            registry_url_hint: None,
        };
        let state_dir = get_config_dir(&state_options)?;
        let base_url = resolve_openclaw_base_url(&state_dir, None)?;

        let existing_runtime = load_relay_runtime_config(&state_dir)?;
        let relay_transform_peers_path = existing_runtime
            .as_ref()
            .and_then(|config| config.relay_transform_peers_path.clone());

        let webhook_token = resolve_openclaw_hook_token(&state_dir, opts.webhook_token.as_deref())?;
        let webhook_url = self.resolve_webhook_url(opts)?;

        let mut config = read_json_or_default(&config_path)?;

        {
            let clawdentity = ensure_json_object_path(&mut config, &["clawdentity"])?;
            clawdentity.insert("provider".to_string(), json!(PROVIDER_NAME));
            clawdentity.insert(
                "webhook".to_string(),
                json!({
                    "enabled": true,
                    "url": webhook_url,
                    "host": opts
                        .webhook_host
                        .as_deref()
                        .unwrap_or(self.default_webhook_host()),
                    "port": opts.webhook_port.unwrap_or(self.default_webhook_port()),
                    "path": OPENCLAW_WEBHOOK_PATH,
                    "token": webhook_token,
                    "connectorUrl": opts.connector_url,
                }),
            );
        }

        {
            let hooks = ensure_json_object_path(&mut config, &["hooks"])?;
            hooks.insert(
                "agent".to_string(),
                json!({
                    "url": self.resolve_webhook_url(opts)?,
                    "token": resolve_openclaw_hook_token(&state_dir, opts.webhook_token.as_deref())?,
                }),
            );
        }

        write_json(&config_path, &config)?;

        let runtime_path = save_relay_runtime_config(
            &state_dir,
            OpenclawRelayRuntimeConfig {
                openclaw_base_url: base_url,
                openclaw_hook_token: resolve_openclaw_hook_token(
                    &state_dir,
                    opts.webhook_token.as_deref(),
                )?,
                relay_transform_peers_path,
                updated_at: None,
            },
        )?;

        Ok(InstallResult {
            platform: self.name().to_string(),
            config_updated: true,
            service_installed: false,
            notes: vec![
                format!("updated {}", config_path.display()),
                format!("updated {}", runtime_path.display()),
                format!("configured webhook path {OPENCLAW_WEBHOOK_PATH}"),
            ],
        })
    }

    fn verify(&self) -> Result<VerifyResult> {
        let state_options = ConfigPathOptions {
            home_dir: self.home_dir_override.clone(),
            registry_url_hint: None,
        };
        let state_dir = get_config_dir(&state_options)?;
        let store = SqliteStore::open(&state_options)?;

        let doctor = run_openclaw_doctor(
            &state_dir,
            &store,
            OpenclawDoctorOptions {
                home_dir: self.home_dir_override.clone(),
                include_connector_runtime_check: true,
                ..OpenclawDoctorOptions::default()
            },
        )?;

        let checks = doctor
            .checks
            .into_iter()
            .map(|check| {
                let passed = check.status == DoctorCheckStatus::Pass;
                let detail = if let Some(remediation_hint) = check.remediation_hint {
                    format!("{} | fix: {remediation_hint}", check.message)
                } else {
                    check.message
                };
                (check.id, passed, detail)
            })
            .collect();

        Ok(VerifyResult {
            healthy: doctor.status == DoctorStatus::Healthy,
            checks,
        })
    }

    fn doctor(&self, opts: &ProviderDoctorOptions) -> Result<ProviderDoctorResult> {
        let state_options = ConfigPathOptions {
            home_dir: opts.home_dir.clone().or(self.home_dir_override.clone()),
            registry_url_hint: None,
        };
        let state_dir = get_config_dir(&state_options)?;
        let store = SqliteStore::open(&state_options)?;

        let doctor = run_openclaw_doctor(
            &state_dir,
            &store,
            OpenclawDoctorOptions {
                home_dir: opts.home_dir.clone().or(self.home_dir_override.clone()),
                openclaw_dir: opts.platform_state_dir.clone(),
                selected_agent: opts.selected_agent.clone(),
                peer_alias: opts.peer_alias.clone(),
                connector_base_url: opts.connector_base_url.clone(),
                include_connector_runtime_check: opts.include_connector_runtime_check,
            },
        )?;

        let checks = doctor
            .checks
            .into_iter()
            .map(|check| crate::provider::ProviderDoctorCheck {
                id: check.id,
                label: check.label,
                status: if check.status == DoctorCheckStatus::Pass {
                    ProviderDoctorCheckStatus::Pass
                } else {
                    ProviderDoctorCheckStatus::Fail
                },
                message: check.message,
                remediation_hint: check.remediation_hint,
                details: check.details,
            })
            .collect();

        Ok(ProviderDoctorResult {
            platform: self.name().to_string(),
            status: if doctor.status == DoctorStatus::Healthy {
                ProviderDoctorStatus::Healthy
            } else {
                ProviderDoctorStatus::Unhealthy
            },
            checks,
        })
    }

    fn setup(&self, opts: &ProviderSetupOptions) -> Result<ProviderSetupResult> {
        let state_options = ConfigPathOptions {
            home_dir: opts.home_dir.clone().or(self.home_dir_override.clone()),
            registry_url_hint: None,
        };
        let config_dir = get_config_dir(&state_options)?;
        let agent_name = opts
            .agent_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                crate::error::CoreError::InvalidInput("agent name is required".to_string())
            })?;

        let marker_path = write_selected_openclaw_agent(&config_dir, agent_name)?;
        let resolved_base_url =
            resolve_openclaw_base_url(&config_dir, opts.platform_base_url.as_deref())?;
        let existing_runtime = load_relay_runtime_config(&config_dir)?;
        let runtime_path = save_relay_runtime_config(
            &config_dir,
            OpenclawRelayRuntimeConfig {
                openclaw_base_url: resolved_base_url,
                openclaw_hook_token: opts.webhook_token.clone().or_else(|| {
                    existing_runtime
                        .as_ref()
                        .and_then(|cfg| cfg.openclaw_hook_token.clone())
                }),
                relay_transform_peers_path: opts.relay_transform_peers_path.clone().or_else(|| {
                    existing_runtime
                        .as_ref()
                        .and_then(|cfg| cfg.relay_transform_peers_path.clone())
                }),
                updated_at: Some(now_iso()),
            },
        )?;

        let connector_assignment_path = if let Some(base_url) = opts.connector_base_url.as_deref() {
            Some(save_connector_assignment(
                &config_dir,
                agent_name,
                base_url,
            )?)
        } else {
            None
        };

        let install_result = self.install(&InstallOptions {
            home_dir: opts.home_dir.clone().or(self.home_dir_override.clone()),
            webhook_port: opts.webhook_port,
            webhook_host: opts.webhook_host.clone(),
            webhook_token: opts.webhook_token.clone(),
            connector_url: opts
                .connector_url
                .clone()
                .or(opts.connector_base_url.clone()),
        })?;

        let mut updated_paths = vec![
            marker_path.display().to_string(),
            runtime_path.display().to_string(),
        ];
        if let Some(path) = connector_assignment_path {
            updated_paths.push(path.display().to_string());
        }
        let mut notes = install_result.notes;
        notes.push(format!("selected agent marker saved for `{agent_name}`"));
        Ok(ProviderSetupResult {
            platform: self.name().to_string(),
            notes,
            updated_paths,
        })
    }

    fn relay_test(&self, opts: &ProviderRelayTestOptions) -> Result<ProviderRelayTestResult> {
        let state_options = ConfigPathOptions {
            home_dir: opts.home_dir.clone().or(self.home_dir_override.clone()),
            registry_url_hint: None,
        };
        let config_dir = get_config_dir(&state_options)?;
        let store = SqliteStore::open(&state_options)?;
        let result = run_openclaw_relay_test(
            &config_dir,
            &store,
            OpenclawRelayTestOptions {
                home_dir: opts.home_dir.clone().or(self.home_dir_override.clone()),
                openclaw_dir: opts.platform_state_dir.clone(),
                peer_alias: opts.peer_alias.clone(),
                openclaw_base_url: opts.platform_base_url.clone(),
                hook_token: opts.webhook_token.clone(),
                message: opts.message.clone(),
                session_id: opts.session_id.clone(),
                skip_preflight: opts.skip_preflight,
            },
        )?;
        Ok(ProviderRelayTestResult {
            platform: self.name().to_string(),
            status: if result.status == RelayCheckStatus::Success {
                ProviderRelayTestStatus::Success
            } else {
                ProviderRelayTestStatus::Failure
            },
            checked_at: result.checked_at,
            endpoint: result.endpoint,
            peer_alias: Some(result.peer_alias),
            http_status: result.http_status,
            message: result.message,
            remediation_hint: result.remediation_hint,
            preflight: result.preflight.map(|preflight| ProviderDoctorResult {
                platform: self.name().to_string(),
                status: if preflight.status == DoctorStatus::Healthy {
                    ProviderDoctorStatus::Healthy
                } else {
                    ProviderDoctorStatus::Unhealthy
                },
                checks: preflight
                    .checks
                    .into_iter()
                    .map(|check| crate::provider::ProviderDoctorCheck {
                        id: check.id,
                        label: check.label,
                        status: if check.status == DoctorCheckStatus::Pass {
                            ProviderDoctorCheckStatus::Pass
                        } else {
                            ProviderDoctorCheckStatus::Fail
                        },
                        message: check.message,
                        remediation_hint: check.remediation_hint,
                        details: check.details,
                    })
                    .collect(),
            }),
            details: None,
        })
    }
}


mod setup {
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
}

mod doctor {
    use std::fs;
    use std::io::ErrorKind;
    use std::path::{Path, PathBuf};
    
    use serde::{Deserialize, Serialize};
    use serde_json::Value;
    
    use crate::constants::{AGENTS_DIR, AIT_FILE_NAME, SECRET_KEY_FILE_NAME};
    use crate::db::SqliteStore;
    use crate::error::{CoreError, Result};
    use crate::http::blocking_client;
    use super::setup::{
        OPENCLAW_DEFAULT_BASE_URL, load_relay_runtime_config, openclaw_agent_name_path,
        read_selected_openclaw_agent, resolve_connector_base_url, resolve_openclaw_hook_token,
    };
    use crate::peers::load_peers_config;
    
    const RELAY_TRANSFORM_MODULE_RELATIVE_PATH: &str = "hooks/transforms/relay-to-peer.mjs";
    const OPENCLAW_PENDING_DEVICES_RELATIVE_PATH: &str = "devices/pending.json";
    const STATUS_PATH: &str = "/v1/status";
    
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "lowercase")]
    pub enum DoctorCheckStatus {
        Pass,
        Fail,
    }
    
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "lowercase")]
    pub enum DoctorStatus {
        Healthy,
        Unhealthy,
    }
    
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct OpenclawDoctorCheck {
        pub id: String,
        pub label: String,
        pub status: DoctorCheckStatus,
        pub message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub remediation_hint: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub details: Option<Value>,
    }
    
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct OpenclawDoctorResult {
        pub status: DoctorStatus,
        pub checks: Vec<OpenclawDoctorCheck>,
    }
    
    #[derive(Debug, Clone, Default)]
    pub struct OpenclawDoctorOptions {
        pub home_dir: Option<PathBuf>,
        pub openclaw_dir: Option<PathBuf>,
        pub selected_agent: Option<String>,
        pub peer_alias: Option<String>,
        pub connector_base_url: Option<String>,
        pub include_connector_runtime_check: bool,
    }
    
    fn push_check(
        checks: &mut Vec<OpenclawDoctorCheck>,
        id: &str,
        label: &str,
        status: DoctorCheckStatus,
        message: impl Into<String>,
        remediation_hint: Option<&str>,
        details: Option<Value>,
    ) {
        checks.push(OpenclawDoctorCheck {
            id: id.to_string(),
            label: label.to_string(),
            status,
            message: message.into(),
            remediation_hint: remediation_hint.map(ToOwned::to_owned),
            details,
        });
    }
    
    fn resolve_openclaw_dir(home_dir: Option<&Path>, override_dir: Option<&Path>) -> Result<PathBuf> {
        if let Some(path) = override_dir {
            return Ok(path.to_path_buf());
        }
    
        if let Ok(path) = std::env::var("OPENCLAW_STATE_DIR") {
            let trimmed = path.trim();
            if !trimmed.is_empty() {
                return Ok(PathBuf::from(trimmed));
            }
        }
    
        if let Ok(path) = std::env::var("OPENCLAW_CONFIG_PATH") {
            let trimmed = path.trim();
            if !trimmed.is_empty() {
                let path = PathBuf::from(trimmed);
                return Ok(path.parent().map(Path::to_path_buf).unwrap_or(path));
            }
        }
    
        let home = if let Some(home_dir) = home_dir {
            home_dir.to_path_buf()
        } else {
            dirs::home_dir().ok_or(CoreError::HomeDirectoryUnavailable)?
        };
        Ok(home.join(".openclaw"))
    }
    
    fn read_non_empty_file(path: &Path) -> Result<bool> {
        let content = fs::read_to_string(path).map_err(|source| CoreError::Io {
            path: path.to_path_buf(),
            source,
        })?;
        Ok(!content.trim().is_empty())
    }
    
    fn get_status_url(base_url: &str) -> Result<String> {
        let normalized = if base_url.ends_with('/') {
            base_url.to_string()
        } else {
            format!("{base_url}/")
        };
        let joined = url::Url::parse(&normalized)
            .map_err(|_| CoreError::InvalidUrl {
                context: "connectorBaseUrl",
                value: base_url.to_string(),
            })?
            .join(STATUS_PATH.trim_start_matches('/'))
            .map_err(|_| CoreError::InvalidUrl {
                context: "connectorBaseUrl",
                value: base_url.to_string(),
            })?;
        Ok(joined.to_string())
    }
    
    fn parse_pending_approvals_count(path: &Path) -> Result<usize> {
        let raw = match fs::read_to_string(path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(0),
            Err(source) => {
                return Err(CoreError::Io {
                    path: path.to_path_buf(),
                    source,
                });
            }
        };
        let payload: Value = serde_json::from_str(&raw).map_err(|source| CoreError::JsonParse {
            path: path.to_path_buf(),
            source,
        })?;
    
        if let Some(array) = payload.as_array() {
            return Ok(array.len());
        }
        if let Some(array) = payload.get("requests").and_then(|value| value.as_array()) {
            return Ok(array.len());
        }
        Ok(0)
    }
    
    fn run_connector_checks(
        checks: &mut Vec<OpenclawDoctorCheck>,
        config_dir: &Path,
        selected_agent: Option<&str>,
        connector_base_url: Option<&str>,
    ) -> Result<()> {
        let resolved_base_url =
            resolve_connector_base_url(config_dir, selected_agent, connector_base_url)?;
        let Some(base_url) = resolved_base_url else {
            push_check(
                checks,
                "state.connectorRuntime",
                "Connector runtime",
                DoctorCheckStatus::Fail,
                "connector runtime assignment is missing for selected agent",
                Some("Run `openclaw setup <agentName>` or pass `--connector-base-url`."),
                None,
            );
            push_check(
                checks,
                "state.connectorInboundInbox",
                "Connector inbound inbox",
                DoctorCheckStatus::Fail,
                "cannot validate connector inbox without connector assignment",
                Some("Run `openclaw setup <agentName>` or pass `--connector-base-url`."),
                None,
            );
            push_check(
                checks,
                "state.openclawHookHealth",
                "OpenClaw hook health",
                DoctorCheckStatus::Fail,
                "cannot validate OpenClaw hook health without connector runtime",
                Some("Run `openclaw setup <agentName>` and restart connector runtime."),
                None,
            );
            return Ok(());
        };
    
        let status_url = get_status_url(&base_url)?;
        let response = blocking_client()?
            .get(&status_url)
            .header("accept", "application/json")
            .send();
    
        let response = match response {
            Ok(response) => response,
            Err(error) => {
                push_check(
                    checks,
                    "state.connectorRuntime",
                    "Connector runtime",
                    DoctorCheckStatus::Fail,
                    format!("connector status request failed: {error}"),
                    Some("Ensure connector runtime is running and reachable."),
                    Some(serde_json::json!({ "connectorBaseUrl": base_url, "statusUrl": status_url })),
                );
                push_check(
                    checks,
                    "state.connectorInboundInbox",
                    "Connector inbound inbox",
                    DoctorCheckStatus::Fail,
                    "cannot read connector inbound inbox status",
                    Some("Start connector runtime and retry."),
                    Some(serde_json::json!({ "connectorBaseUrl": base_url, "statusUrl": status_url })),
                );
                push_check(
                    checks,
                    "state.openclawHookHealth",
                    "OpenClaw hook health",
                    DoctorCheckStatus::Fail,
                    "cannot read connector OpenClaw hook status",
                    Some("Restart connector runtime and OpenClaw."),
                    Some(serde_json::json!({ "connectorBaseUrl": base_url, "statusUrl": status_url })),
                );
                return Ok(());
            }
        };
    
        if !response.status().is_success() {
            let status = response.status().as_u16();
            push_check(
                checks,
                "state.connectorRuntime",
                "Connector runtime",
                DoctorCheckStatus::Fail,
                format!("connector status returned HTTP {status}"),
                Some("Ensure connector runtime is running and reachable."),
                Some(serde_json::json!({ "connectorBaseUrl": base_url, "statusUrl": status_url })),
            );
            push_check(
                checks,
                "state.connectorInboundInbox",
                "Connector inbound inbox",
                DoctorCheckStatus::Fail,
                "cannot read connector inbound inbox status",
                Some("Start connector runtime and retry."),
                Some(serde_json::json!({ "connectorBaseUrl": base_url, "statusUrl": status_url })),
            );
            push_check(
                checks,
                "state.openclawHookHealth",
                "OpenClaw hook health",
                DoctorCheckStatus::Fail,
                "cannot read connector OpenClaw hook status",
                Some("Restart connector runtime and OpenClaw."),
                Some(serde_json::json!({ "connectorBaseUrl": base_url, "statusUrl": status_url })),
            );
            return Ok(());
        }
    
        let payload: Value = response
            .json()
            .map_err(|error| CoreError::Http(error.to_string()))?;
        let websocket_connected = payload
            .get("websocket")
            .and_then(|value| value.get("connected"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let inbound_pending = payload
            .get("inbound")
            .and_then(|value| value.get("pending"))
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let inbound_dead_letter = payload
            .get("inbound")
            .and_then(|value| value.get("deadLetter"))
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let hook_last_attempt_status = payload
            .get("inbound")
            .and_then(|value| value.get("openclawHook"))
            .and_then(|value| value.get("lastAttemptStatus"))
            .and_then(Value::as_str);
    
        if websocket_connected {
            push_check(
                checks,
                "state.connectorRuntime",
                "Connector runtime",
                DoctorCheckStatus::Pass,
                "connector websocket is connected",
                None,
                Some(serde_json::json!({ "connectorBaseUrl": base_url, "statusUrl": status_url })),
            );
            push_check(
                checks,
                "state.connectorInboundInbox",
                "Connector inbound inbox",
                DoctorCheckStatus::Pass,
                format!(
                    "pending={} deadLetter={}",
                    inbound_pending, inbound_dead_letter
                ),
                None,
                Some(
                    serde_json::json!({ "pendingCount": inbound_pending, "deadLetterCount": inbound_dead_letter }),
                ),
            );
            let hook_failed = hook_last_attempt_status == Some("failed");
            push_check(
                checks,
                "state.openclawHookHealth",
                "OpenClaw hook health",
                if hook_failed && inbound_pending > 0 {
                    DoctorCheckStatus::Fail
                } else {
                    DoctorCheckStatus::Pass
                },
                if hook_failed && inbound_pending > 0 {
                    "connector reports failed OpenClaw hook replay with pending inbox backlog"
                } else {
                    "OpenClaw hook replay is healthy"
                },
                if hook_failed && inbound_pending > 0 {
                    Some("Restart OpenClaw and connector runtime, then replay pending inbox messages.")
                } else {
                    None
                },
                None,
            );
        } else {
            push_check(
                checks,
                "state.connectorRuntime",
                "Connector runtime",
                DoctorCheckStatus::Fail,
                "connector websocket is disconnected",
                Some("Run `connector start <agentName>` or `connector service install <agentName>`."),
                Some(serde_json::json!({ "connectorBaseUrl": base_url, "statusUrl": status_url })),
            );
            push_check(
                checks,
                "state.connectorInboundInbox",
                "Connector inbound inbox",
                DoctorCheckStatus::Fail,
                "connector websocket is disconnected; inbox status may be stale",
                Some("Start connector runtime and retry."),
                Some(
                    serde_json::json!({ "pendingCount": inbound_pending, "deadLetterCount": inbound_dead_letter }),
                ),
            );
            push_check(
                checks,
                "state.openclawHookHealth",
                "OpenClaw hook health",
                DoctorCheckStatus::Fail,
                "connector websocket is disconnected; hook replay is unavailable",
                Some("Restart connector runtime and OpenClaw."),
                None,
            );
        }
    
        Ok(())
    }
    
    pub fn run_openclaw_doctor(
        config_dir: &Path,
        store: &SqliteStore,
        options: OpenclawDoctorOptions,
    ) -> Result<OpenclawDoctorResult> {
        let openclaw_dir =
            resolve_openclaw_dir(options.home_dir.as_deref(), options.openclaw_dir.as_deref())?;
        let mut checks = Vec::<OpenclawDoctorCheck>::new();
    
        let selected_agent = options
            .selected_agent
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .or(read_selected_openclaw_agent(config_dir)?);
    
        if let Some(agent_name) = selected_agent.clone() {
            push_check(
                &mut checks,
                "state.selectedAgent",
                "Selected agent",
                DoctorCheckStatus::Pass,
                format!("selected agent is `{agent_name}`"),
                None,
                Some(serde_json::json!({
                    "path": openclaw_agent_name_path(config_dir),
                    "agentName": agent_name
                })),
            );
        } else {
            push_check(
                &mut checks,
                "state.selectedAgent",
                "Selected agent",
                DoctorCheckStatus::Fail,
                "selected agent marker is missing",
                Some("Run `openclaw setup <agentName>` to persist selected agent."),
                Some(serde_json::json!({ "path": openclaw_agent_name_path(config_dir) })),
            );
        }
    
        if let Some(agent_name) = selected_agent.as_deref() {
            let agent_dir = config_dir.join(AGENTS_DIR).join(agent_name);
            let ait_path = agent_dir.join(AIT_FILE_NAME);
            let secret_path = agent_dir.join(SECRET_KEY_FILE_NAME);
            let credentials_ok = read_non_empty_file(&ait_path).unwrap_or(false)
                && read_non_empty_file(&secret_path).unwrap_or(false);
            if credentials_ok {
                push_check(
                    &mut checks,
                    "state.credentials",
                    "Agent credentials",
                    DoctorCheckStatus::Pass,
                    "local agent credentials are present",
                    None,
                    Some(serde_json::json!({
                        "agentDir": agent_dir,
                        "ait": ait_path,
                        "secretKey": secret_path
                    })),
                );
            } else {
                push_check(
                    &mut checks,
                    "state.credentials",
                    "Agent credentials",
                    DoctorCheckStatus::Fail,
                    "local agent credentials are missing or unreadable",
                    Some("Run `agent create <agentName>` and retry setup."),
                    Some(serde_json::json!({
                        "agentDir": agent_dir,
                        "ait": ait_path,
                        "secretKey": secret_path
                    })),
                );
            }
        } else {
            push_check(
                &mut checks,
                "state.credentials",
                "Agent credentials",
                DoctorCheckStatus::Fail,
                "cannot validate credentials without selected agent",
                Some("Run `openclaw setup <agentName>` first."),
                None,
            );
        }
    
        match load_peers_config(store) {
            Ok(peers) => {
                if peers.peers.is_empty() {
                    push_check(
                        &mut checks,
                        "state.peers",
                        "Paired peers",
                        DoctorCheckStatus::Fail,
                        "no paired peers found",
                        Some("Run `pair start`/`pair confirm` before relay checks."),
                        None,
                    );
                } else if let Some(peer_alias) = options.peer_alias.as_deref().map(str::trim) {
                    if peers.peers.contains_key(peer_alias) {
                        push_check(
                            &mut checks,
                            "state.peers",
                            "Paired peers",
                            DoctorCheckStatus::Pass,
                            format!("peer alias `{peer_alias}` is configured"),
                            None,
                            Some(serde_json::json!({ "peerCount": peers.peers.len() })),
                        );
                    } else {
                        push_check(
                            &mut checks,
                            "state.peers",
                            "Paired peers",
                            DoctorCheckStatus::Fail,
                            format!("peer alias `{peer_alias}` is not configured"),
                            Some("Choose an existing peer alias from peers.json."),
                            Some(
                                serde_json::json!({ "peerAliases": peers.peers.keys().collect::<Vec<_>>() }),
                            ),
                        );
                    }
                } else {
                    push_check(
                        &mut checks,
                        "state.peers",
                        "Paired peers",
                        DoctorCheckStatus::Pass,
                        format!("{} paired peer(s) configured", peers.peers.len()),
                        None,
                        Some(serde_json::json!({ "peerCount": peers.peers.len() })),
                    );
                }
            }
            Err(error) => {
                push_check(
                    &mut checks,
                    "state.peers",
                    "Paired peers",
                    DoctorCheckStatus::Fail,
                    format!("unable to load peers: {error}"),
                    Some("Repair local state and retry pairing."),
                    None,
                );
            }
        }
    
        let transform_path = openclaw_dir.join(RELAY_TRANSFORM_MODULE_RELATIVE_PATH);
        if transform_path.exists() {
            push_check(
                &mut checks,
                "state.transformMapping",
                "Relay transform mapping",
                DoctorCheckStatus::Pass,
                "relay transform module is present",
                None,
                Some(serde_json::json!({ "transformPath": transform_path })),
            );
        } else {
            push_check(
                &mut checks,
                "state.transformMapping",
                "Relay transform mapping",
                DoctorCheckStatus::Fail,
                "relay transform module is missing",
                Some("Install OpenClaw relay skill or run setup to restore mapping."),
                Some(serde_json::json!({ "transformPath": transform_path })),
            );
        }
    
        let runtime_config = load_relay_runtime_config(config_dir)?;
        let hook_token = resolve_openclaw_hook_token(config_dir, None)?;
        if hook_token.is_some() {
            push_check(
                &mut checks,
                "state.hookToken",
                "OpenClaw hook token",
                DoctorCheckStatus::Pass,
                "hook token is configured",
                None,
                runtime_config.map(|config| serde_json::to_value(config).unwrap_or(Value::Null)),
            );
        } else {
            push_check(
                &mut checks,
                "state.hookToken",
                "OpenClaw hook token",
                DoctorCheckStatus::Fail,
                "hook token is missing",
                Some("Run `openclaw setup <agentName>` to persist runtime hook token."),
                None,
            );
        }
    
        let pending_path = openclaw_dir.join(OPENCLAW_PENDING_DEVICES_RELATIVE_PATH);
        let pending_count = parse_pending_approvals_count(&pending_path)?;
        if pending_count == 0 {
            push_check(
                &mut checks,
                "state.gatewayPairing",
                "OpenClaw gateway pairing",
                DoctorCheckStatus::Pass,
                "no pending OpenClaw device approvals",
                None,
                Some(serde_json::json!({ "pendingPath": pending_path, "pendingCount": 0 })),
            );
        } else {
            push_check(
                &mut checks,
                "state.gatewayPairing",
                "OpenClaw gateway pairing",
                DoctorCheckStatus::Fail,
                format!("{pending_count} pending OpenClaw device approval(s)"),
                Some("Approve pending devices in OpenClaw before relay diagnostics."),
                Some(serde_json::json!({ "pendingPath": pending_path, "pendingCount": pending_count })),
            );
        }
    
        if options.include_connector_runtime_check {
            run_connector_checks(
                &mut checks,
                config_dir,
                selected_agent.as_deref(),
                options.connector_base_url.as_deref(),
            )?;
        } else {
            push_check(
                &mut checks,
                "state.connectorRuntime",
                "Connector runtime",
                DoctorCheckStatus::Pass,
                "connector runtime check skipped by caller",
                None,
                Some(serde_json::json!({ "defaultConnectorBaseUrl": OPENCLAW_DEFAULT_BASE_URL })),
            );
        }
    
        let status = if checks
            .iter()
            .any(|check| check.status == DoctorCheckStatus::Fail)
        {
            DoctorStatus::Unhealthy
        } else {
            DoctorStatus::Healthy
        };
    
        Ok(OpenclawDoctorResult { status, checks })
    }
    
    #[cfg(test)]
    mod tests {
        use tempfile::TempDir;
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
    
        use crate::db::SqliteStore;
        use super::super::setup::{
            OpenclawRelayRuntimeConfig, save_connector_assignment, save_relay_runtime_config,
            write_selected_openclaw_agent,
        };
        use crate::peers::{PersistPeerInput, persist_peer};
    
        use super::{DoctorStatus, OpenclawDoctorOptions, run_openclaw_doctor};
    
        #[tokio::test]
        async fn doctor_reports_healthy_when_runtime_is_ready() {
            let temp = TempDir::new().expect("temp dir");
            let config_dir = temp.path().join("state");
            std::fs::create_dir_all(config_dir.join("agents/alpha")).expect("agent dir");
            std::fs::write(config_dir.join("agents/alpha/ait.jwt"), "token").expect("ait");
            std::fs::write(config_dir.join("agents/alpha/secret.key"), "secret").expect("secret");
            write_selected_openclaw_agent(&config_dir, "alpha").expect("selected");
            save_relay_runtime_config(
                &config_dir,
                OpenclawRelayRuntimeConfig {
                    openclaw_base_url: "http://127.0.0.1:18789".to_string(),
                    openclaw_hook_token: Some("token".to_string()),
                    relay_transform_peers_path: None,
                    updated_at: None,
                },
            )
            .expect("runtime config");
    
            let openclaw_dir = temp.path().join("openclaw");
            std::fs::create_dir_all(openclaw_dir.join("hooks/transforms")).expect("transform dir");
            std::fs::write(
                openclaw_dir.join("hooks/transforms/relay-to-peer.mjs"),
                "export default {}",
            )
            .expect("transform");
            std::fs::create_dir_all(openclaw_dir.join("devices")).expect("devices dir");
            std::fs::write(openclaw_dir.join("devices/pending.json"), "[]").expect("pending");
    
            let store = SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("db");
            let _ = persist_peer(
                &store,
                PersistPeerInput {
                    alias: Some("peer-alpha".to_string()),
                    did: "did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4".to_string(),
                    proxy_url: "https://proxy.example/hooks/agent".to_string(),
                    agent_name: Some("alpha".to_string()),
                    human_name: Some("alice".to_string()),
                },
            )
            .expect("peer");
    
            let server = MockServer::start().await;
            Mock::given(method("GET"))
                .and(path("/v1/status"))
                .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "websocket": { "connected": true },
                    "inbound": { "pending": 0, "deadLetter": 0 }
                })))
                .mount(&server)
                .await;
    
            save_connector_assignment(&config_dir, "alpha", &server.uri()).expect("assignment");
            let doctor_config_dir = config_dir.clone();
            let doctor_store = store.clone();
            let result = tokio::task::spawn_blocking(move || {
                run_openclaw_doctor(
                    &doctor_config_dir,
                    &doctor_store,
                    OpenclawDoctorOptions {
                        openclaw_dir: Some(openclaw_dir),
                        include_connector_runtime_check: true,
                        ..OpenclawDoctorOptions::default()
                    },
                )
            })
            .await
            .expect("join")
            .expect("doctor");
            assert_eq!(result.status, DoctorStatus::Healthy);
        }
    
        #[test]
        fn doctor_fails_when_selected_agent_marker_is_missing() {
            let temp = TempDir::new().expect("temp dir");
            let config_dir = temp.path().join("state");
            std::fs::create_dir_all(&config_dir).expect("state dir");
            let store = SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("db");
            let result = run_openclaw_doctor(
                &config_dir,
                &store,
                OpenclawDoctorOptions {
                    include_connector_runtime_check: false,
                    ..OpenclawDoctorOptions::default()
                },
            )
            .expect("doctor");
            assert_eq!(result.status, DoctorStatus::Unhealthy);
            assert!(
                result
                    .checks
                    .iter()
                    .any(|check| check.id == "state.selectedAgent"
                        && check.status == super::DoctorCheckStatus::Fail)
            );
        }
    }
}

mod relay_test {
    use std::path::{Path, PathBuf};
    
    use serde::{Deserialize, Serialize};
    
    use crate::db::SqliteStore;
    use crate::error::{CoreError, Result};
    use crate::http::blocking_client;
    use super::doctor::{
        DoctorStatus, OpenclawDoctorOptions, OpenclawDoctorResult, run_openclaw_doctor,
    };
    use super::setup::{
        read_selected_openclaw_agent, resolve_connector_base_url, resolve_openclaw_base_url,
        resolve_openclaw_hook_token,
    };
    use crate::peers::load_peers_config;
    
    const OPENCLAW_SEND_TO_PEER_PATH: &str = "/hooks/send-to-peer";
    const STATUS_PATH: &str = "/v1/status";
    
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "lowercase")]
    pub enum RelayCheckStatus {
        Success,
        Failure,
    }
    
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct OpenclawRelayTestResult {
        pub status: RelayCheckStatus,
        pub checked_at: String,
        pub peer_alias: String,
        pub endpoint: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub http_status: Option<u16>,
        pub message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub remediation_hint: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub preflight: Option<OpenclawDoctorResult>,
    }
    
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct OpenclawRelayWebsocketTestResult {
        pub status: RelayCheckStatus,
        pub checked_at: String,
        pub peer_alias: String,
        pub connector_status_url: String,
        pub message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub remediation_hint: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub preflight: Option<OpenclawDoctorResult>,
    }
    
    #[derive(Debug, Clone, Default)]
    pub struct OpenclawRelayTestOptions {
        pub home_dir: Option<PathBuf>,
        pub openclaw_dir: Option<PathBuf>,
        pub peer_alias: Option<String>,
        pub openclaw_base_url: Option<String>,
        pub hook_token: Option<String>,
        pub message: Option<String>,
        pub session_id: Option<String>,
        pub skip_preflight: bool,
    }
    
    #[derive(Debug, Clone, Default)]
    pub struct OpenclawRelayWebsocketTestOptions {
        pub home_dir: Option<PathBuf>,
        pub openclaw_dir: Option<PathBuf>,
        pub peer_alias: Option<String>,
        pub connector_base_url: Option<String>,
        pub skip_preflight: bool,
    }
    
    fn now_iso() -> String {
        chrono::Utc::now().to_rfc3339()
    }
    
    fn resolve_peer_alias(store: &SqliteStore, peer_alias: Option<&str>) -> Result<String> {
        let peers = load_peers_config(store)?;
        if peers.peers.is_empty() {
            return Err(CoreError::InvalidInput(
                "no paired peers found; complete pairing first".to_string(),
            ));
        }
    
        if let Some(peer_alias) = peer_alias.map(str::trim).filter(|value| !value.is_empty()) {
            if peers.peers.contains_key(peer_alias) {
                return Ok(peer_alias.to_string());
            }
            return Err(CoreError::InvalidInput(format!(
                "peer alias `{peer_alias}` is not configured"
            )));
        }
    
        if peers.peers.len() == 1 {
            return Ok(peers.peers.keys().next().cloned().unwrap_or_default());
        }
    
        Err(CoreError::InvalidInput(
            "multiple peers are configured; pass a peer alias".to_string(),
        ))
    }
    
    fn join_url(base_url: &str, path: &str, context: &'static str) -> Result<String> {
        let normalized = if base_url.ends_with('/') {
            base_url.to_string()
        } else {
            format!("{base_url}/")
        };
        let joined = url::Url::parse(&normalized)
            .map_err(|_| CoreError::InvalidUrl {
                context,
                value: base_url.to_string(),
            })?
            .join(path.trim_start_matches('/'))
            .map_err(|_| CoreError::InvalidUrl {
                context,
                value: base_url.to_string(),
            })?;
        Ok(joined.to_string())
    }
    
    fn map_probe_failure(status: u16) -> (&'static str, &'static str) {
        match status {
            401 | 403 => (
                "OpenClaw hook token was rejected",
                "Provide a valid hook token with --hook-token or OPENCLAW_HOOK_TOKEN.",
            ),
            404 => (
                "OpenClaw send-to-peer hook is unavailable",
                "Run `openclaw setup <agentName>` to install hook mapping.",
            ),
            500 => (
                "Relay probe failed inside local relay pipeline",
                "Verify peer pairing and restart OpenClaw + connector runtime.",
            ),
            _ => (
                "Relay probe failed",
                "Check OpenClaw and connector logs for request failure details.",
            ),
        }
    }
    
    fn run_preflight(
        config_dir: &Path,
        store: &SqliteStore,
        home_dir: Option<PathBuf>,
        openclaw_dir: Option<PathBuf>,
    ) -> Result<OpenclawDoctorResult> {
        run_openclaw_doctor(
            config_dir,
            store,
            OpenclawDoctorOptions {
                home_dir,
                openclaw_dir,
                include_connector_runtime_check: false,
                ..OpenclawDoctorOptions::default()
            },
        )
    }
    
    pub fn run_openclaw_relay_test(
        config_dir: &Path,
        store: &SqliteStore,
        options: OpenclawRelayTestOptions,
    ) -> Result<OpenclawRelayTestResult> {
        let checked_at = now_iso();
        let peer_alias = resolve_peer_alias(store, options.peer_alias.as_deref())?;
        let preflight = if options.skip_preflight {
            None
        } else {
            Some(run_preflight(
                config_dir,
                store,
                options.home_dir.clone(),
                options.openclaw_dir.clone(),
            )?)
        };
        if preflight.as_ref().map(|result| &result.status) == Some(&DoctorStatus::Unhealthy) {
            return Ok(OpenclawRelayTestResult {
                status: RelayCheckStatus::Failure,
                checked_at,
                peer_alias,
                endpoint: OPENCLAW_SEND_TO_PEER_PATH.to_string(),
                http_status: None,
                message: "Preflight checks failed".to_string(),
                remediation_hint: Some("Run `openclaw doctor` and resolve failed checks.".to_string()),
                preflight,
            });
        }
    
        let openclaw_base_url =
            resolve_openclaw_base_url(config_dir, options.openclaw_base_url.as_deref())?;
        let endpoint = join_url(
            &openclaw_base_url,
            OPENCLAW_SEND_TO_PEER_PATH,
            "openclawBaseUrl",
        )?;
        let hook_token = resolve_openclaw_hook_token(config_dir, options.hook_token.as_deref())?;
        let session_id = options
            .session_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| format!("clawdentity-probe-{}", chrono::Utc::now().timestamp()));
        let message = options
            .message
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| "clawdentity relay probe".to_string());
    
        let mut request = blocking_client()?
            .post(&endpoint)
            .header("content-type", "application/json")
            .json(&serde_json::json!({
                "peer": peer_alias,
                "sessionId": session_id,
                "message": message,
            }));
        if let Some(token) = hook_token {
            request = request.header("x-openclaw-token", token);
        }
        let response = request
            .send()
            .map_err(|error| CoreError::Http(error.to_string()))?;
    
        if response.status().is_success() {
            return Ok(OpenclawRelayTestResult {
                status: RelayCheckStatus::Success,
                checked_at,
                peer_alias: resolve_peer_alias(store, options.peer_alias.as_deref())?,
                endpoint,
                http_status: Some(response.status().as_u16()),
                message: "Relay probe accepted".to_string(),
                remediation_hint: None,
                preflight,
            });
        }
    
        let status = response.status().as_u16();
        let (message, remediation_hint) = map_probe_failure(status);
        Ok(OpenclawRelayTestResult {
            status: RelayCheckStatus::Failure,
            checked_at,
            peer_alias: resolve_peer_alias(store, options.peer_alias.as_deref())?,
            endpoint,
            http_status: Some(status),
            message: message.to_string(),
            remediation_hint: Some(remediation_hint.to_string()),
            preflight,
        })
    }
    
    pub fn run_openclaw_relay_websocket_test(
        config_dir: &Path,
        store: &SqliteStore,
        options: OpenclawRelayWebsocketTestOptions,
    ) -> Result<OpenclawRelayWebsocketTestResult> {
        let checked_at = now_iso();
        let peer_alias = resolve_peer_alias(store, options.peer_alias.as_deref())?;
        let preflight = if options.skip_preflight {
            None
        } else {
            Some(run_preflight(
                config_dir,
                store,
                options.home_dir.clone(),
                options.openclaw_dir.clone(),
            )?)
        };
        if preflight.as_ref().map(|result| &result.status) == Some(&DoctorStatus::Unhealthy) {
            return Ok(OpenclawRelayWebsocketTestResult {
                status: RelayCheckStatus::Failure,
                checked_at,
                peer_alias,
                connector_status_url: STATUS_PATH.to_string(),
                message: "Preflight checks failed".to_string(),
                remediation_hint: Some("Run `openclaw doctor` and resolve failed checks.".to_string()),
                preflight,
            });
        }
    
        let selected_agent = read_selected_openclaw_agent(config_dir)?;
        let connector_base_url = resolve_connector_base_url(
            config_dir,
            selected_agent.as_deref(),
            options.connector_base_url.as_deref(),
        )?
        .ok_or_else(|| {
            CoreError::InvalidInput(
                "connector base URL is not configured; run openclaw setup first".to_string(),
            )
        })?;
        let connector_status_url = join_url(&connector_base_url, STATUS_PATH, "connectorBaseUrl")?;
        let response = blocking_client()?
            .get(&connector_status_url)
            .header("accept", "application/json")
            .send()
            .map_err(|error| CoreError::Http(error.to_string()))?;
    
        if !response.status().is_success() {
            return Ok(OpenclawRelayWebsocketTestResult {
                status: RelayCheckStatus::Failure,
                checked_at,
                peer_alias,
                connector_status_url,
                message: format!(
                    "Connector status endpoint returned HTTP {}",
                    response.status()
                ),
                remediation_hint: Some("Start connector runtime and retry websocket test.".to_string()),
                preflight,
            });
        }
    
        let payload: serde_json::Value = response
            .json()
            .map_err(|error| CoreError::Http(error.to_string()))?;
        let connected = payload
            .get("websocket")
            .and_then(|value| value.get("connected"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        if connected {
            return Ok(OpenclawRelayWebsocketTestResult {
                status: RelayCheckStatus::Success,
                checked_at,
                peer_alias,
                connector_status_url,
                message: "Connector websocket is connected for paired relay".to_string(),
                remediation_hint: None,
                preflight,
            });
        }
    
        Ok(OpenclawRelayWebsocketTestResult {
            status: RelayCheckStatus::Failure,
            checked_at,
            peer_alias,
            connector_status_url,
            message: "Connector websocket is disconnected".to_string(),
            remediation_hint: Some(
                "Run `connector start <agentName>` or reinstall connector service.".to_string(),
            ),
            preflight,
        })
    }
    
    #[cfg(test)]
    mod tests {
        use tempfile::TempDir;
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
    
        use crate::db::SqliteStore;
        use crate::peers::{PersistPeerInput, persist_peer};
    
        use super::{
            OpenclawRelayTestOptions, OpenclawRelayWebsocketTestOptions, RelayCheckStatus,
            run_openclaw_relay_test, run_openclaw_relay_websocket_test,
        };
    
        fn seed_peer(store: &SqliteStore) {
            let _ = persist_peer(
                store,
                PersistPeerInput {
                    alias: Some("peer-alpha".to_string()),
                    did: "did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4".to_string(),
                    proxy_url: "https://proxy.example/hooks/agent".to_string(),
                    agent_name: Some("alpha".to_string()),
                    human_name: Some("alice".to_string()),
                },
            )
            .expect("peer");
        }
    
        #[tokio::test]
        async fn relay_test_returns_success_for_accepted_probe() {
            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .and(path("/hooks/send-to-peer"))
                .respond_with(ResponseTemplate::new(202))
                .mount(&server)
                .await;
    
            let temp = TempDir::new().expect("temp dir");
            let config_dir = temp.path().join("state");
            std::fs::create_dir_all(&config_dir).expect("state dir");
            let store = SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("db");
            seed_peer(&store);
    
            let relay_config_dir = config_dir.clone();
            let relay_store = store.clone();
            let result = tokio::task::spawn_blocking(move || {
                run_openclaw_relay_test(
                    &relay_config_dir,
                    &relay_store,
                    OpenclawRelayTestOptions {
                        peer_alias: Some("peer-alpha".to_string()),
                        openclaw_base_url: Some(server.uri()),
                        skip_preflight: true,
                        ..OpenclawRelayTestOptions::default()
                    },
                )
            })
            .await
            .expect("join")
            .expect("relay test");
            assert_eq!(result.status, RelayCheckStatus::Success);
        }
    
        #[tokio::test]
        async fn relay_websocket_test_reports_connected_status() {
            let server = MockServer::start().await;
            Mock::given(method("GET"))
                .and(path("/v1/status"))
                .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "websocket": { "connected": true }
                })))
                .mount(&server)
                .await;
    
            let temp = TempDir::new().expect("temp dir");
            let config_dir = temp.path().join("state");
            std::fs::create_dir_all(&config_dir).expect("state dir");
            let store = SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("db");
            seed_peer(&store);
    
            let ws_config_dir = config_dir.clone();
            let ws_store = store.clone();
            let result = tokio::task::spawn_blocking(move || {
                run_openclaw_relay_websocket_test(
                    &ws_config_dir,
                    &ws_store,
                    OpenclawRelayWebsocketTestOptions {
                        peer_alias: Some("peer-alpha".to_string()),
                        connector_base_url: Some(server.uri()),
                        skip_preflight: true,
                        ..OpenclawRelayWebsocketTestOptions::default()
                    },
                )
            })
            .await
            .expect("join")
            .expect("ws test");
            assert_eq!(result.status, RelayCheckStatus::Success);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use tempfile::TempDir;

    use crate::provider::{InboundMessage, PlatformProvider};

    use super::{OPENCLAW_CONFIG_FILE_NAME, OPENCLAW_DIR_NAME, OpenclawProvider};

    #[test]
    fn detection_checks_home_and_path_evidence() {
        let home = TempDir::new().expect("temp home");
        let openclaw_dir = home.path().join(OPENCLAW_DIR_NAME);
        std::fs::create_dir_all(&openclaw_dir).expect("openclaw dir");
        std::fs::write(openclaw_dir.join(OPENCLAW_CONFIG_FILE_NAME), "{}\n").expect("config");

        let bin_dir = TempDir::new().expect("temp bin");
        std::fs::write(bin_dir.path().join("openclaw"), "#!/bin/sh\n").expect("binary");

        let provider = OpenclawProvider::with_test_context(
            home.path().to_path_buf(),
            vec![bin_dir.path().to_path_buf()],
        );
        let detection = provider.detect();

        assert!(detection.detected);
        assert!(detection.confidence > 0.9);
        assert!(
            detection
                .evidence
                .iter()
                .any(|entry| entry.contains("openclaw binary in PATH"))
        );
    }

    #[test]
    fn format_inbound_uses_openclaw_webhook_shape() {
        let provider = OpenclawProvider::default();
        let mut metadata = HashMap::new();
        metadata.insert("thread".to_string(), "relay".to_string());

        let request = provider.format_inbound(&InboundMessage {
            sender_did: "did:claw:sender".to_string(),
            recipient_did: "did:claw:recipient".to_string(),
            content: "hello".to_string(),
            request_id: Some("req-123".to_string()),
            metadata,
        });

        assert_eq!(
            request
                .headers
                .get("x-webhook-sender-id")
                .map(String::as_str),
            Some("did:claw:sender")
        );
        assert_eq!(
            request.body.get("content").and_then(|value| value.as_str()),
            Some("hello")
        );
        assert_eq!(
            request.body.get("path").and_then(|value| value.as_str()),
            Some("/hooks/agent")
        );
    }

    #[test]
    fn config_path_points_to_openclaw_json() {
        let home = TempDir::new().expect("temp home");
        let provider = OpenclawProvider::with_test_context(home.path().to_path_buf(), Vec::new());

        assert_eq!(
            provider.config_path(),
            Some(
                home.path()
                    .join(OPENCLAW_DIR_NAME)
                    .join(OPENCLAW_CONFIG_FILE_NAME)
            )
        );
    }
}
