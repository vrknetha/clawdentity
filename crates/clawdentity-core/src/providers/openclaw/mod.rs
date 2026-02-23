use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::json;

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
use crate::config::{ConfigPathOptions, get_config_dir};
use crate::db::SqliteStore;
use crate::error::Result;
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

#[allow(clippy::too_many_lines)]
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

#[allow(clippy::too_many_lines)]
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

#[allow(clippy::too_many_lines)]
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

mod doctor;
mod relay_test;
mod setup;

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
