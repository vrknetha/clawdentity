use std::collections::HashMap;
use std::path::PathBuf;

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
    OPENCLAW_AGENT_FILE_NAME, OPENCLAW_CONFIG_FILE_NAME, OPENCLAW_CONNECTORS_FILE_NAME,
    OPENCLAW_DEFAULT_BASE_URL, OPENCLAW_RELAY_RUNTIME_FILE_NAME, OpenclawConnectorAssignment,
    OpenclawConnectorsConfig, OpenclawRelayRuntimeConfig, build_connector_base_url,
    connector_port_from_base_url, load_connector_assignments, load_relay_runtime_config,
    openclaw_agent_name_path, openclaw_connectors_path, openclaw_relay_runtime_path,
    read_selected_openclaw_agent, resolve_connector_base_url, resolve_openclaw_base_url,
    resolve_openclaw_config_path, resolve_openclaw_dir, resolve_openclaw_hook_token,
    save_connector_assignment, save_relay_runtime_config, suggest_connector_base_url,
    write_selected_openclaw_agent,
};

use self::assets::{
    install_openclaw_skill_assets, patch_openclaw_config, read_openclaw_config_hook_token,
    transform_peers_path, verify_openclaw_install, write_transform_peers_snapshot,
    write_transform_runtime_config,
};
use crate::config::{ConfigPathOptions, get_config_dir};
use crate::db::SqliteStore;
use crate::error::Result;
use crate::provider::{
    DetectionResult, InboundMessage, InboundRequest, InstallOptions, InstallResult,
    PlatformProvider, ProviderDoctorCheckStatus, ProviderDoctorOptions, ProviderDoctorResult,
    ProviderDoctorStatus, ProviderRelayTestOptions, ProviderRelayTestResult,
    ProviderRelayTestStatus, ProviderSetupOptions, ProviderSetupResult, VerifyResult,
    command_exists, default_webhook_url, join_url_path, now_iso, resolve_home_dir_with_fallback,
};

const PROVIDER_NAME: &str = "openclaw";
const PROVIDER_DISPLAY_NAME: &str = "OpenClaw";
const OPENCLAW_BINARY: &str = "openclaw";
const OPENCLAW_WEBHOOK_PATH: &str = "/hooks/agent";

#[derive(Debug, Clone, Default)]
pub struct OpenclawProvider {
    home_dir_override: Option<PathBuf>,
    path_override: Option<Vec<PathBuf>>,
}

struct OpenclawSetupContext {
    state_options: ConfigPathOptions,
    config_dir: PathBuf,
    openclaw_dir: PathBuf,
    store: SqliteStore,
    agent_name: String,
}

struct OpenclawSetupArtifacts {
    notes: Vec<String>,
    updated_paths: Vec<String>,
}

impl OpenclawProvider {
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

    fn resolve_provider_state_options(&self, home_dir: Option<PathBuf>) -> ConfigPathOptions {
        ConfigPathOptions {
            home_dir: home_dir.or(self.home_dir_override.clone()),
            registry_url_hint: None,
        }
    }

    fn resolve_setup_context(&self, opts: &ProviderSetupOptions) -> Result<OpenclawSetupContext> {
        let state_options = self.resolve_provider_state_options(opts.home_dir.clone());
        let config_dir = get_config_dir(&state_options)?;
        let openclaw_dir = resolve_openclaw_dir(state_options.home_dir.as_deref(), None)?;
        let store = SqliteStore::open(&state_options)?;
        let agent_name = opts
            .agent_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                crate::error::CoreError::InvalidInput("agent name is required".to_string())
            })?
            .to_string();
        Ok(OpenclawSetupContext {
            state_options,
            config_dir,
            openclaw_dir,
            store,
            agent_name,
        })
    }

    fn resolve_setup_connector_base_url(
        &self,
        opts: &ProviderSetupOptions,
        config_dir: &std::path::Path,
        agent_name: &str,
    ) -> String {
        opts.connector_base_url.clone().unwrap_or_else(|| {
            suggest_connector_base_url(config_dir, agent_name)
                .unwrap_or_else(|_| build_connector_base_url("127.0.0.1", 19400))
        })
    }

    fn resolve_setup_runtime_paths(
        &self,
        opts: &ProviderSetupOptions,
        config_dir: &std::path::Path,
        openclaw_dir: &std::path::Path,
    ) -> (Option<OpenclawRelayRuntimeConfig>, String) {
        let existing_runtime = load_relay_runtime_config(config_dir).ok().flatten();
        let peers_path = opts
            .relay_transform_peers_path
            .clone()
            .unwrap_or_else(|| transform_peers_path(openclaw_dir).display().to_string());
        (existing_runtime, peers_path)
    }

    fn persist_setup_artifacts(
        &self,
        context: &OpenclawSetupContext,
        opts: &ProviderSetupOptions,
        connector_base_url: &str,
        install_notes: Vec<String>,
    ) -> Result<OpenclawSetupArtifacts> {
        let marker_path = write_selected_openclaw_agent(&context.config_dir, &context.agent_name)?;
        let runtime_path = self.save_setup_runtime_config(context, opts, connector_base_url)?;
        let connector_assignment_path = save_connector_assignment(
            &context.config_dir,
            &context.agent_name,
            connector_base_url,
        )?;
        let relay_snapshot_path = write_transform_peers_snapshot(
            &context.openclaw_dir,
            &crate::peers::load_peers_config(&context.store)?,
        )?;
        let relay_runtime_path = write_transform_runtime_config(
            &context.openclaw_dir,
            connector_port_from_base_url(connector_base_url).unwrap_or(19400),
        )?;
        Ok(self.finalize_setup_artifacts(
            context,
            connector_base_url,
            install_notes,
            [
                marker_path,
                runtime_path,
                connector_assignment_path,
                relay_snapshot_path,
                relay_runtime_path,
            ],
        ))
    }

    fn save_setup_runtime_config(
        &self,
        context: &OpenclawSetupContext,
        opts: &ProviderSetupOptions,
        _connector_base_url: &str,
    ) -> Result<PathBuf> {
        let resolved_base_url =
            resolve_openclaw_base_url(&context.config_dir, opts.platform_base_url.as_deref())?;
        let (existing_runtime, relay_transform_peers_path) =
            self.resolve_setup_runtime_paths(opts, &context.config_dir, &context.openclaw_dir);
        let config_path =
            resolve_openclaw_config_path(context.state_options.home_dir.as_deref(), None)?;
        save_relay_runtime_config(
            &context.config_dir,
            OpenclawRelayRuntimeConfig {
                openclaw_base_url: resolved_base_url,
                openclaw_hook_token: opts
                    .webhook_token
                    .clone()
                    .or_else(|| existing_runtime.and_then(|cfg| cfg.openclaw_hook_token))
                    .or(read_openclaw_config_hook_token(&config_path)?),
                relay_transform_peers_path: Some(relay_transform_peers_path),
                updated_at: Some(now_iso()),
            },
        )
    }

    fn finalize_setup_artifacts(
        &self,
        context: &OpenclawSetupContext,
        connector_base_url: &str,
        install_notes: Vec<String>,
        paths: [PathBuf; 5],
    ) -> OpenclawSetupArtifacts {
        let mut updated_paths = paths
            .into_iter()
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>();
        updated_paths.sort();
        updated_paths.dedup();

        let mut notes = install_notes;
        notes.push(format!(
            "selected agent marker saved for `{}`",
            context.agent_name
        ));
        notes.push(format!(
            "connector assignment saved as `{connector_base_url}`"
        ));
        OpenclawSetupArtifacts {
            notes,
            updated_paths,
        }
    }

    fn map_relay_test_preflight(&self, preflight: OpenclawDoctorResult) -> ProviderDoctorResult {
        ProviderDoctorResult {
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
        }
    }

    fn map_relay_test_result(&self, result: OpenclawRelayTestResult) -> ProviderRelayTestResult {
        ProviderRelayTestResult {
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
            preflight: result
                .preflight
                .map(|preflight| self.map_relay_test_preflight(preflight)),
            details: None,
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

        if let Ok(openclaw_dir) = resolve_openclaw_dir(self.home_dir_override.as_deref(), None)
            && openclaw_dir.is_dir()
        {
            evidence.push(format!("found {}/", openclaw_dir.display()));
            confidence += 0.65;
        }

        if let Ok(config_path) =
            resolve_openclaw_config_path(self.home_dir_override.as_deref(), None)
            && config_path.is_file()
        {
            evidence.push(format!("found {}", config_path.display()));
            confidence += 0.1;
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
        resolve_openclaw_config_path(self.home_dir_override.as_deref(), None).ok()
    }

    fn install(&self, opts: &InstallOptions) -> Result<InstallResult> {
        let home_dir = self.install_home_dir(opts)?;
        let openclaw_dir = resolve_openclaw_dir(Some(&home_dir), None)?;
        let config_path = resolve_openclaw_config_path(Some(&home_dir), None)?;

        let state_options = ConfigPathOptions {
            home_dir: Some(home_dir.clone()),
            registry_url_hint: None,
        };
        let state_dir = get_config_dir(&state_options)?;
        let webhook_token = resolve_openclaw_hook_token(&state_dir, opts.webhook_token.as_deref())?;
        let webhook_url = self.resolve_webhook_url(opts)?;

        let mut notes = install_openclaw_skill_assets(&openclaw_dir)?;
        let patch_result = patch_openclaw_config(
            &config_path,
            &webhook_url,
            opts.webhook_host
                .as_deref()
                .unwrap_or(self.default_webhook_host()),
            opts.webhook_port.unwrap_or(self.default_webhook_port()),
            OPENCLAW_WEBHOOK_PATH,
            webhook_token.as_deref(),
        )?;
        notes.push(format!(
            "{} {}",
            if patch_result.config_changed {
                "updated"
            } else {
                "verified"
            },
            config_path.display()
        ));
        notes.push(format!("configured webhook path {OPENCLAW_WEBHOOK_PATH}"));

        Ok(InstallResult {
            platform: self.name().to_string(),
            config_updated: true,
            service_installed: false,
            notes,
        })
    }

    fn verify(&self, opts: &crate::provider::VerifyOptions) -> Result<VerifyResult> {
        let home_dir = opts.home_dir.clone().or(self.home_dir_override.clone());
        let config_path = resolve_openclaw_config_path(home_dir.as_deref(), None)?;
        let openclaw_dir = resolve_openclaw_dir(home_dir.as_deref(), None)?;
        let checks = verify_openclaw_install(&config_path, &openclaw_dir)?;

        Ok(VerifyResult {
            healthy: checks.iter().all(|(_, passed, _)| *passed),
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
        let context = self.resolve_setup_context(opts)?;
        let connector_base_url =
            self.resolve_setup_connector_base_url(opts, &context.config_dir, &context.agent_name);
        let install_result = self.install(&InstallOptions {
            home_dir: opts.home_dir.clone().or(self.home_dir_override.clone()),
            webhook_port: opts.webhook_port,
            webhook_host: opts.webhook_host.clone(),
            webhook_token: opts.webhook_token.clone(),
            connector_url: opts
                .connector_url
                .clone()
                .or(Some(connector_base_url.clone())),
        })?;
        let artifacts = self.persist_setup_artifacts(
            &context,
            opts,
            &connector_base_url,
            install_result.notes,
        )?;
        Ok(ProviderSetupResult {
            platform: self.name().to_string(),
            notes: artifacts.notes,
            updated_paths: artifacts.updated_paths,
        })
    }

    fn relay_test(&self, opts: &ProviderRelayTestOptions) -> Result<ProviderRelayTestResult> {
        let state_options = self.resolve_provider_state_options(opts.home_dir.clone());
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
        Ok(self.map_relay_test_result(result))
    }
}

mod assets;
mod doctor;
mod relay_test;
mod setup;

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use tempfile::TempDir;

    use crate::provider::{InboundMessage, PlatformProvider};

    use super::{OPENCLAW_CONFIG_FILE_NAME, OpenclawProvider, resolve_openclaw_dir};

    #[test]
    fn detection_checks_home_and_path_evidence() {
        let home = TempDir::new().expect("temp home");
        let openclaw_dir = resolve_openclaw_dir(Some(home.path()), None).expect("openclaw dir");
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
            sender_did: "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXTB"
                .to_string(),
            recipient_did: "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXTC"
                .to_string(),
            content: "hello".to_string(),
            request_id: Some("req-123".to_string()),
            metadata,
        });

        assert_eq!(
            request
                .headers
                .get("x-webhook-sender-id")
                .map(String::as_str),
            Some("did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXTB")
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
                resolve_openclaw_dir(Some(home.path()), None)
                    .expect("openclaw dir")
                    .join(OPENCLAW_CONFIG_FILE_NAME)
            )
        );
    }
}
