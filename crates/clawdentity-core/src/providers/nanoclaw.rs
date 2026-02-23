use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;

use serde_json::json;

use crate::error::{CoreError, Result};
use crate::http::blocking_client;
use crate::provider::{
    DetectionResult, InboundMessage, InboundRequest, InstallOptions, InstallResult,
    PlatformProvider, ProviderDoctorCheckStatus, ProviderDoctorOptions, ProviderDoctorResult,
    ProviderRelayRuntimeConfig, ProviderRelayTestOptions, ProviderRelayTestResult,
    ProviderRelayTestStatus, ProviderSetupOptions, ProviderSetupResult, VerifyResult,
    check_connector_runtime, command_exists, default_webhook_url, doctor_status_from_checks,
    health_check, join_url_path, load_provider_runtime_config, now_iso, push_doctor_check,
    read_provider_agent_marker, read_text, resolve_state_dir, save_provider_runtime_config,
    upsert_env_var, write_provider_agent_marker, write_text,
};

const PROVIDER_NAME: &str = "nanoclaw";
const PROVIDER_DISPLAY_NAME: &str = "NanoClaw";
const NANOCLAW_BINARY: &str = "nanoclaw";
const NANOCLAW_WEBHOOK_PATH: &str = "/v1/inbound";
const NANOCLAW_SKILL_COMMAND: [&str; 3] = [
    "tsx",
    "scripts/apply-skill.ts",
    ".claude/skills/add-webhook",
];

#[derive(Debug, Clone, Default)]
pub struct NanoclawProvider {
    project_root_override: Option<PathBuf>,
    path_override: Option<Vec<PathBuf>>,
}

impl NanoclawProvider {
    fn project_root(&self) -> Option<PathBuf> {
        self.project_root_override
            .clone()
            .or_else(|| std::env::current_dir().ok())
    }

    fn install_project_root(&self, opts: &InstallOptions) -> Result<PathBuf> {
        if let Some(project_root) = opts.home_dir.as_ref() {
            return Ok(project_root.clone());
        }

        self.project_root().ok_or(CoreError::InvalidInput(
            "unable to resolve project root".to_string(),
        ))
    }

    fn resolve_webhook_url(&self, opts: &InstallOptions) -> Result<String> {
        if let Some(connector_url) = opts
            .connector_url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return join_url_path(connector_url, NANOCLAW_WEBHOOK_PATH, "connectorUrl");
        }

        let host = opts
            .webhook_host
            .as_deref()
            .unwrap_or(self.default_webhook_host());
        let port = opts.webhook_port.unwrap_or(self.default_webhook_port());
        default_webhook_url(host, port, NANOCLAW_WEBHOOK_PATH)
    }

    #[cfg(test)]
    fn with_test_context(project_root: PathBuf, path_override: Vec<PathBuf>) -> Self {
        Self {
            project_root_override: Some(project_root),
            path_override: Some(path_override),
        }
    }
}

impl PlatformProvider for NanoclawProvider {
    fn name(&self) -> &str {
        PROVIDER_NAME
    }

    fn display_name(&self) -> &str {
        PROVIDER_DISPLAY_NAME
    }

    fn detect(&self) -> DetectionResult {
        let mut evidence = Vec::new();
        let mut confidence: f32 = 0.0;

        if let Some(project_root) = self.project_root() {
            let claude_dir = project_root.join(".claude");
            if claude_dir.is_dir() {
                evidence.push(format!("found {}/", claude_dir.display()));
                confidence += 0.45;
            }

            let skills_dir = claude_dir.join("skills");
            if skills_dir.is_dir() {
                evidence.push(format!("found {}/", skills_dir.display()));
                confidence += 0.3;
            }

            if project_root.join("scripts/apply-skill.ts").is_file() {
                evidence.push("found scripts/apply-skill.ts".to_string());
                confidence += 0.1;
            }
        }

        if command_exists(NANOCLAW_BINARY, self.path_override.as_deref()) {
            evidence.push("nanoclaw binary in PATH".to_string());
            confidence += 0.15;
        }

        DetectionResult {
            detected: confidence > 0.0,
            confidence: confidence.min(1.0),
            evidence,
        }
    }

    fn format_inbound(&self, message: &InboundMessage) -> InboundRequest {
        InboundRequest {
            headers: HashMap::new(),
            body: json!({
                "userId": message.sender_did,
                "content": message.content,
            }),
        }
    }

    fn default_webhook_port(&self) -> u16 {
        18794
    }

    fn config_path(&self) -> Option<PathBuf> {
        self.project_root()
            .map(|project_root| project_root.join(".env"))
    }

#[allow(clippy::too_many_lines)]
    fn install(&self, opts: &InstallOptions) -> Result<InstallResult> {
        let project_root = self.install_project_root(opts)?;
        let env_path = project_root.join(".env");

        let command_output = Command::new("npx")
            .args(NANOCLAW_SKILL_COMMAND)
            .current_dir(&project_root)
            .output()
            .map_err(|error| {
                CoreError::InvalidInput(format!("failed to run nanoclaw skill installer: {error}"))
            })?;

        if !command_output.status.success() {
            let stderr = String::from_utf8_lossy(&command_output.stderr)
                .trim()
                .to_string();
            return Err(CoreError::InvalidInput(format!(
                "nanoclaw skill installer failed: {}",
                if stderr.is_empty() {
                    "unknown error".to_string()
                } else {
                    stderr
                }
            )));
        }

        let webhook_url = self.resolve_webhook_url(opts)?;

        let mut env_contents = read_text(&env_path)?.unwrap_or_default();
        env_contents = upsert_env_var(&env_contents, "CLAWDENTITY_WEBHOOK_URL", &webhook_url);

        if let Some(token) = opts
            .webhook_token
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            env_contents = upsert_env_var(&env_contents, "CLAWDENTITY_WEBHOOK_TOKEN", token);
        }

        if let Some(connector_url) = opts
            .connector_url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            env_contents =
                upsert_env_var(&env_contents, "CLAWDENTITY_CONNECTOR_URL", connector_url);
        }

        write_text(&env_path, &env_contents)?;

        Ok(InstallResult {
            platform: self.name().to_string(),
            config_updated: true,
            service_installed: true,
            notes: vec![
                "applied .claude skill add-webhook".to_string(),
                format!("updated {}", env_path.display()),
            ],
        })
    }

    fn verify(&self) -> Result<VerifyResult> {
        let (healthy, detail) =
            health_check(self.default_webhook_host(), self.default_webhook_port())?;
        Ok(VerifyResult {
            healthy,
            checks: vec![("health".to_string(), healthy, detail)],
        })
    }

#[allow(clippy::too_many_lines)]
    fn doctor(&self, opts: &ProviderDoctorOptions) -> Result<ProviderDoctorResult> {
        let mut checks = Vec::new();
        let state_dir = resolve_state_dir(opts.home_dir.clone())?;

        let config_path = self.config_path();
        if let Some(config_path) = config_path {
            if config_path.exists() {
                push_doctor_check(
                    &mut checks,
                    "config.exists",
                    "Config file",
                    ProviderDoctorCheckStatus::Pass,
                    format!("found {}", config_path.display()),
                    None,
                    None,
                );
            } else {
                push_doctor_check(
                    &mut checks,
                    "config.exists",
                    "Config file",
                    ProviderDoctorCheckStatus::Fail,
                    format!("missing {}", config_path.display()),
                    Some("Run `clawdentity provider setup --for nanoclaw`.".to_string()),
                    None,
                );
            }
        }

        let binary_found = command_exists(NANOCLAW_BINARY, self.path_override.as_deref());
        push_doctor_check(
            &mut checks,
            "binary.path",
            "Provider binary",
            if binary_found {
                ProviderDoctorCheckStatus::Pass
            } else {
                ProviderDoctorCheckStatus::Fail
            },
            if binary_found {
                "nanoclaw binary found in PATH".to_string()
            } else {
                "nanoclaw binary not found in PATH".to_string()
            },
            if binary_found {
                None
            } else {
                Some("Install NanoClaw and ensure `nanoclaw` is in PATH.".to_string())
            },
            None,
        );

        let (webhook_ok, webhook_detail) =
            health_check(self.default_webhook_host(), self.default_webhook_port())?;
        push_doctor_check(
            &mut checks,
            "webhook.health",
            "Webhook endpoint",
            if webhook_ok {
                ProviderDoctorCheckStatus::Pass
            } else {
                ProviderDoctorCheckStatus::Fail
            },
            webhook_detail,
            if webhook_ok {
                None
            } else {
                Some("Start local webhook runtime and verify configured port.".to_string())
            },
            None,
        );

        let runtime = load_provider_runtime_config(&state_dir, self.name())?;
        match read_provider_agent_marker(&state_dir, self.name())? {
            Some(agent_name) => push_doctor_check(
                &mut checks,
                "state.selectedAgent",
                "Selected agent",
                ProviderDoctorCheckStatus::Pass,
                format!("selected agent is `{agent_name}`"),
                None,
                None,
            ),
            None => push_doctor_check(
                &mut checks,
                "state.selectedAgent",
                "Selected agent",
                ProviderDoctorCheckStatus::Fail,
                "selected agent marker is missing".to_string(),
                Some("Run provider setup and choose an agent name.".to_string()),
                None,
            ),
        }
        let connector_base_url = opts.connector_base_url.clone().or_else(|| {
            runtime
                .as_ref()
                .and_then(|cfg| cfg.connector_base_url.clone())
        });
        if opts.include_connector_runtime_check {
            if let Some(connector_base_url) = connector_base_url {
                let (connected, detail) = check_connector_runtime(&connector_base_url)?;
                push_doctor_check(
                    &mut checks,
                    "connector.runtime",
                    "Connector runtime",
                    if connected {
                        ProviderDoctorCheckStatus::Pass
                    } else {
                        ProviderDoctorCheckStatus::Fail
                    },
                    detail,
                    if connected {
                        None
                    } else {
                        Some("Start connector runtime and retry provider doctor.".to_string())
                    },
                    Some(serde_json::json!({ "connectorBaseUrl": connector_base_url })),
                );
            } else {
                push_doctor_check(
                    &mut checks,
                    "connector.runtime",
                    "Connector runtime",
                    ProviderDoctorCheckStatus::Fail,
                    "connector base URL is not configured".to_string(),
                    Some("Run setup with `--connector-base-url` or pass it to doctor.".to_string()),
                    None,
                );
            }
        }

        Ok(ProviderDoctorResult {
            platform: self.name().to_string(),
            status: doctor_status_from_checks(&checks),
            checks,
        })
    }

    fn setup(&self, opts: &ProviderSetupOptions) -> Result<ProviderSetupResult> {
        let install_options = InstallOptions {
            home_dir: opts.home_dir.clone(),
            webhook_port: opts.webhook_port,
            webhook_host: opts.webhook_host.clone(),
            webhook_token: opts.webhook_token.clone(),
            connector_url: opts
                .connector_url
                .clone()
                .or_else(|| opts.connector_base_url.clone()),
        };
        let install_result = self.install(&install_options)?;
        let state_dir = resolve_state_dir(opts.home_dir.clone())?;
        let agent_name = opts
            .agent_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("default");
        let marker_path = write_provider_agent_marker(&state_dir, self.name(), agent_name)?;
        let webhook_endpoint = self.resolve_webhook_url(&install_options)?;
        let runtime_path = save_provider_runtime_config(
            &state_dir,
            self.name(),
            ProviderRelayRuntimeConfig {
                webhook_endpoint,
                connector_base_url: opts.connector_base_url.clone(),
                webhook_token: opts.webhook_token.clone(),
                platform_base_url: opts.platform_base_url.clone(),
                relay_transform_peers_path: opts.relay_transform_peers_path.clone(),
                updated_at: now_iso(),
            },
        )?;

        let mut notes = install_result.notes;
        notes.push(format!("saved selected agent marker `{agent_name}`"));
        notes.push("saved provider relay runtime".to_string());
        Ok(ProviderSetupResult {
            platform: self.name().to_string(),
            notes,
            updated_paths: vec![
                marker_path.display().to_string(),
                runtime_path.display().to_string(),
            ],
        })
    }

#[allow(clippy::too_many_lines)]
    fn relay_test(&self, opts: &ProviderRelayTestOptions) -> Result<ProviderRelayTestResult> {
        let checked_at = now_iso();
        let state_dir = resolve_state_dir(opts.home_dir.clone())?;
        let runtime = load_provider_runtime_config(&state_dir, self.name())?;

        let preflight = if opts.skip_preflight {
            None
        } else {
            Some(self.doctor(&ProviderDoctorOptions {
                home_dir: opts.home_dir.clone(),
                platform_state_dir: opts.platform_state_dir.clone(),
                selected_agent: None,
                peer_alias: opts.peer_alias.clone(),
                connector_base_url: opts.connector_base_url.clone(),
                include_connector_runtime_check: true,
            })?)
        };
        if preflight
            .as_ref()
            .map(|result| result.status == crate::provider::ProviderDoctorStatus::Unhealthy)
            .unwrap_or(false)
        {
            return Ok(ProviderRelayTestResult {
                platform: self.name().to_string(),
                status: ProviderRelayTestStatus::Failure,
                checked_at,
                endpoint: runtime
                    .as_ref()
                    .map(|cfg| cfg.webhook_endpoint.clone())
                    .unwrap_or_else(|| "unknown".to_string()),
                peer_alias: opts.peer_alias.clone(),
                http_status: None,
                message: "Preflight checks failed".to_string(),
                remediation_hint: Some(
                    "Run provider doctor and resolve failed checks.".to_string(),
                ),
                preflight,
                details: None,
            });
        }

        let endpoint = if let Some(runtime) = runtime {
            runtime.webhook_endpoint
        } else {
            self.resolve_webhook_url(&InstallOptions {
                home_dir: opts.home_dir.clone(),
                webhook_port: None,
                webhook_host: None,
                webhook_token: None,
                connector_url: opts.connector_base_url.clone(),
            })?
        };

        let message = opts
            .message
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("clawdentity relay probe");
        let session_id = opts
            .session_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| {
                format!(
                    "clawdentity-nanoclaw-probe-{}",
                    chrono::Utc::now().timestamp()
                )
            });

        let mut request = blocking_client()?
            .post(&endpoint)
            .header("content-type", "application/json")
            .json(&serde_json::json!({
                "provider": self.name(),
                "sessionId": session_id,
                "message": message,
                "peer": opts.peer_alias,
            }));
        if let Some(token) = opts
            .webhook_token
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            request = request.header("x-clawdentity-token", token);
        }

        let response = match request.send() {
            Ok(response) => response,
            Err(error) => {
                return Ok(ProviderRelayTestResult {
                    platform: self.name().to_string(),
                    status: ProviderRelayTestStatus::Failure,
                    checked_at,
                    endpoint,
                    peer_alias: opts.peer_alias.clone(),
                    http_status: None,
                    message: format!("relay probe request failed: {error}"),
                    remediation_hint: Some(
                        "Verify webhook endpoint is running and reachable from this machine."
                            .to_string(),
                    ),
                    preflight,
                    details: None,
                });
            }
        };

        let status = response.status().as_u16();
        if response.status().is_success() {
            Ok(ProviderRelayTestResult {
                platform: self.name().to_string(),
                status: ProviderRelayTestStatus::Success,
                checked_at,
                endpoint,
                peer_alias: opts.peer_alias.clone(),
                http_status: Some(status),
                message: "relay probe accepted".to_string(),
                remediation_hint: None,
                preflight,
                details: None,
            })
        } else {
            Ok(ProviderRelayTestResult {
                platform: self.name().to_string(),
                status: ProviderRelayTestStatus::Failure,
                checked_at,
                endpoint,
                peer_alias: opts.peer_alias.clone(),
                http_status: Some(status),
                message: format!("relay probe returned HTTP {status}"),
                remediation_hint: Some(
                    "Check provider webhook configuration and connector runtime.".to_string(),
                ),
                preflight,
                details: None,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use tempfile::TempDir;

    use crate::provider::{InboundMessage, PlatformProvider};

    use super::NanoclawProvider;

    #[test]
    fn detection_checks_project_structure_and_path() {
        let project_root = TempDir::new().expect("temp project");
        std::fs::create_dir_all(project_root.path().join(".claude/skills")).expect("skills dir");
        std::fs::create_dir_all(project_root.path().join("scripts")).expect("scripts dir");
        std::fs::write(
            project_root.path().join("scripts/apply-skill.ts"),
            "// noop\n",
        )
        .expect("script");

        let bin_dir = TempDir::new().expect("temp bin");
        std::fs::write(bin_dir.path().join("nanoclaw"), "#!/bin/sh\n").expect("binary");

        let provider = NanoclawProvider::with_test_context(
            project_root.path().to_path_buf(),
            vec![bin_dir.path().to_path_buf()],
        );
        let detection = provider.detect();

        assert!(detection.detected);
        assert!(detection.confidence > 0.8);
        assert!(
            detection
                .evidence
                .iter()
                .any(|entry| entry.contains("found scripts/apply-skill.ts"))
        );
    }

    #[test]
    fn format_inbound_uses_body_payload_shape() {
        let provider = NanoclawProvider::default();

        let request = provider.format_inbound(&InboundMessage {
            sender_did: "did:claw:sender".to_string(),
            recipient_did: "did:claw:recipient".to_string(),
            content: "hello".to_string(),
            request_id: Some("req-123".to_string()),
            metadata: HashMap::new(),
        });

        assert!(request.headers.is_empty());
        assert_eq!(
            request.body.get("userId").and_then(|value| value.as_str()),
            Some("did:claw:sender")
        );
        assert_eq!(
            request.body.get("content").and_then(|value| value.as_str()),
            Some("hello")
        );
    }

    #[test]
    fn config_path_points_to_project_env_file() {
        let project_root = TempDir::new().expect("temp project");
        let provider =
            NanoclawProvider::with_test_context(project_root.path().to_path_buf(), Vec::new());

        assert_eq!(
            provider.config_path(),
            Some(project_root.path().join(".env"))
        );
    }
}
