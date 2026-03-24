use std::collections::HashMap;
use std::fs;
use std::path::Path;
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
use self::cli::ensure_openclaw_cli_available;
use self::connector_runtime::{ConnectorRuntimeEnsureStatus, ensure_local_connector_runtime};
use self::setup::urls_share_service_target;
use crate::config::{ConfigPathOptions, get_config_dir, resolve_config};
use crate::db::SqliteStore;
use crate::error::Result;
use crate::provider::{
    DetectionResult, InboundMessage, InboundRequest, InstallOptions, InstallResult,
    PlatformProvider, ProviderDoctorCheckStatus, ProviderDoctorOptions, ProviderDoctorResult,
    ProviderDoctorStatus, ProviderRelayTestOptions, ProviderRelayTestResult,
    ProviderRelayTestStatus, ProviderSetupOptions, ProviderSetupResult, ProviderSetupStatus,
    VerifyResult, command_exists, now_iso, resolve_home_dir_with_fallback,
};

const PROVIDER_NAME: &str = "openclaw";
const PROVIDER_DISPLAY_NAME: &str = "OpenClaw";
const OPENCLAW_BINARY: &str = "openclaw";
const OPENCLAW_WEBHOOK_PATH: &str = "/hooks/wake";

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

    fn ensure_openclaw_cli(&self) -> Result<PathBuf> {
        ensure_openclaw_cli_available(self.path_override.as_deref())
    }

    fn ensure_openclaw_base_ready(&self, config_path: &Path) -> Result<()> {
        let raw = fs::read_to_string(config_path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                crate::error::CoreError::InvalidInput(
                    "OpenClaw is not initialized yet. Run `openclaw onboard`, confirm OpenClaw works, then retry Clawdentity setup.".to_string(),
                )
            } else {
                crate::error::CoreError::Io {
                    path: config_path.to_path_buf(),
                    source: error,
                }
            }
        })?;

        json5::from_str::<serde_json::Value>(&raw).map_err(|error| {
            crate::error::CoreError::InvalidInput(format!(
                "OpenClaw config is unreadable. Run `openclaw doctor --fix`, confirm OpenClaw works, then retry Clawdentity setup. ({error})"
            ))
        })?;

        Ok(())
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
    ) -> (Option<OpenclawRelayRuntimeConfig>, PathBuf) {
        let existing_runtime = load_relay_runtime_config(config_dir).ok().flatten();
        let peers_path = opts
            .relay_transform_peers_path
            .as_deref()
            .map(PathBuf::from)
            .or_else(|| {
                existing_runtime
                    .as_ref()
                    .and_then(|runtime| runtime.relay_transform_peers_path.as_deref())
                    .map(PathBuf::from)
            })
            .map(|path| {
                if path.is_absolute() {
                    path
                } else {
                    openclaw_dir.join("hooks").join("transforms").join(path)
                }
            })
            .unwrap_or_else(|| transform_peers_path(openclaw_dir));
        (existing_runtime, peers_path)
    }

    fn persist_setup_artifacts(
        &self,
        context: &OpenclawSetupContext,
        opts: &ProviderSetupOptions,
        connector_base_url: &str,
        install_notes: Vec<String>,
    ) -> Result<OpenclawSetupArtifacts> {
        let (_, relay_snapshot_path) =
            self.resolve_setup_runtime_paths(opts, &context.config_dir, &context.openclaw_dir);
        let marker_path = write_selected_openclaw_agent(&context.config_dir, &context.agent_name)?;
        let runtime_path = self.save_setup_runtime_config(
            context,
            opts,
            connector_base_url,
            &relay_snapshot_path,
        )?;
        let connector_assignment_path = save_connector_assignment(
            &context.config_dir,
            &context.agent_name,
            connector_base_url,
        )?;
        let relay_snapshot_path = write_transform_peers_snapshot(
            &relay_snapshot_path,
            &crate::peers::load_peers_config(&context.store)?,
        )?;
        let relay_runtime_path = write_transform_runtime_config(
            &context.openclaw_dir,
            connector_base_url,
            &relay_snapshot_path,
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
        relay_snapshot_path: &std::path::Path,
    ) -> Result<PathBuf> {
        let resolved_base_url =
            resolve_openclaw_base_url(&context.config_dir, opts.platform_base_url.as_deref())?;
        self.validate_setup_openclaw_base_url(context, &resolved_base_url)?;
        let existing_runtime = load_relay_runtime_config(&context.config_dir)
            .ok()
            .flatten();
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
                relay_transform_peers_path: Some(relay_snapshot_path.display().to_string()),
                updated_at: Some(now_iso()),
            },
        )
    }

    fn validate_setup_openclaw_base_url(
        &self,
        context: &OpenclawSetupContext,
        openclaw_base_url: &str,
    ) -> Result<()> {
        let config = resolve_config(&context.state_options)?;
        if let Some(proxy_url) = config.proxy_url.as_deref()
            && urls_share_service_target(openclaw_base_url, proxy_url)
        {
            return Err(crate::error::CoreError::InvalidInput(format!(
                "OpenClaw base URL `{openclaw_base_url}` points at the Clawdentity proxy, not the OpenClaw gateway. Use the local OpenClaw gateway URL and rerun `clawdentity provider setup --for openclaw --agent-name {}`.",
                context.agent_name
            )));
        }
        if urls_share_service_target(openclaw_base_url, &config.registry_url) {
            return Err(crate::error::CoreError::InvalidInput(format!(
                "OpenClaw base URL `{openclaw_base_url}` points at the Clawdentity registry, not the OpenClaw gateway. Use the local OpenClaw gateway URL and rerun `clawdentity provider setup --for openclaw --agent-name {}`.",
                context.agent_name
            )));
        }
        Ok(())
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
        notes.push("next: run `openclaw dashboard` for a quick OpenClaw UI check".to_string());
        notes.push(
            "next: run `clawdentity provider doctor --for openclaw` to validate relay readiness"
                .to_string(),
        );
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
        let wake_text = format!(
            "Clawdentity peer message from {}\n\n{}",
            message.sender_did, message.content
        );
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

        let mut body = json!({
            "message": wake_text,
            "text": wake_text,
            "mode": "now",
            "senderDid": message.sender_did,
            "recipientDid": message.recipient_did,
            "requestId": message.request_id,
            "metadata": message.metadata,
            "path": OPENCLAW_WEBHOOK_PATH,
        });
        if let Some(session_id) = message
            .metadata
            .get("sessionId")
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            body["sessionId"] = json!(session_id);
        }

        InboundRequest { headers, body }
    }

    fn default_webhook_port(&self) -> u16 {
        3001
    }

    fn config_path(&self) -> Option<PathBuf> {
        resolve_openclaw_config_path(self.home_dir_override.as_deref(), None).ok()
    }

    fn install(&self, opts: &InstallOptions) -> Result<InstallResult> {
        let command_path = self.ensure_openclaw_cli()?;
        let home_dir = self.install_home_dir(opts)?;
        let openclaw_dir = resolve_openclaw_dir(Some(&home_dir), None)?;
        let config_path = resolve_openclaw_config_path(Some(&home_dir), None)?;
        self.ensure_openclaw_base_ready(&config_path)?;

        let state_options = ConfigPathOptions {
            home_dir: Some(home_dir.clone()),
            registry_url_hint: None,
        };
        let state_dir = get_config_dir(&state_options)?;
        let webhook_token = resolve_openclaw_hook_token(&state_dir, opts.webhook_token.as_deref())?;

        let mut notes = install_openclaw_skill_assets(&openclaw_dir)?;
        let patch_result = patch_openclaw_config(
            &command_path,
            &openclaw_dir,
            &config_path,
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
            config_updated: patch_result.config_changed,
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
        self.ensure_openclaw_cli()?;
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
        let connector_runtime = ensure_local_connector_runtime(
            &context.state_options,
            &context.agent_name,
            &connector_base_url,
        )?;
        let mut notes = artifacts.notes;
        notes.extend(connector_runtime.notes);
        Ok(ProviderSetupResult {
            platform: self.name().to_string(),
            status: if connector_runtime.status == ConnectorRuntimeEnsureStatus::Ready {
                ProviderSetupStatus::Ready
            } else {
                ProviderSetupStatus::ActionRequired
            },
            notes,
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
mod cli;
mod connector_runtime;
mod doctor;
mod relay_test;
mod setup;

#[cfg(test)]
pub(crate) mod test_support;

#[cfg(test)]
mod connector_runtime_tests;

#[cfg(test)]
mod mod_tests;
