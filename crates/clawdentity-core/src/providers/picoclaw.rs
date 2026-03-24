use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::json;

use crate::error::Result;
use crate::http::blocking_client;
use crate::provider::{
    DetectionResult, InboundMessage, InboundRequest, InstallOptions, InstallResult,
    PlatformProvider, ProviderDoctorCheckStatus, ProviderDoctorOptions, ProviderDoctorResult,
    ProviderRelayRuntimeConfig, ProviderRelayTestOptions, ProviderRelayTestResult,
    ProviderRelayTestStatus, ProviderSetupOptions, ProviderSetupResult, ProviderSetupStatus,
    VerifyResult, check_connector_runtime, command_exists, default_webhook_url,
    doctor_status_from_checks, ensure_json_object_path, health_check, join_url_path,
    load_provider_runtime_config, now_iso, push_doctor_check, read_json_or_default,
    read_provider_agent_marker, resolve_home_dir_with_fallback, resolve_state_dir,
    save_provider_runtime_config, write_json, write_provider_agent_marker,
};

const PROVIDER_NAME: &str = "picoclaw";
const PROVIDER_DISPLAY_NAME: &str = "PicoClaw";
const PICOCLAW_DIR_NAME: &str = ".picoclaw";
const PICOCLAW_CONFIG_FILE_NAME: &str = "config.json";
const PICOCLAW_BINARY: &str = "picoclaw";
const PICOCLAW_WEBHOOK_PATH: &str = "/v1/inbound";

#[derive(Debug, Clone, Default)]
pub struct PicoclawProvider {
    home_dir_override: Option<PathBuf>,
    path_override: Option<Vec<PathBuf>>,
}

impl PicoclawProvider {
    fn resolve_home_dir(&self) -> Option<PathBuf> {
        self.home_dir_override.clone().or_else(dirs::home_dir)
    }

    fn config_path_from_home(home_dir: &Path) -> PathBuf {
        home_dir
            .join(PICOCLAW_DIR_NAME)
            .join(PICOCLAW_CONFIG_FILE_NAME)
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
            return join_url_path(connector_url, PICOCLAW_WEBHOOK_PATH, "connectorUrl");
        }

        let host = opts
            .webhook_host
            .as_deref()
            .unwrap_or(self.default_webhook_host());
        let port = opts.webhook_port.unwrap_or(self.default_webhook_port());
        default_webhook_url(host, port, PICOCLAW_WEBHOOK_PATH)
    }

    #[cfg(test)]
    fn with_test_context(home_dir: PathBuf, path_override: Vec<PathBuf>) -> Self {
        Self {
            home_dir_override: Some(home_dir),
            path_override: Some(path_override),
        }
    }
}

impl PlatformProvider for PicoclawProvider {
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
            let picoclaw_dir = home_dir.join(PICOCLAW_DIR_NAME);
            if picoclaw_dir.is_dir() {
                evidence.push(format!("found {}/", picoclaw_dir.display()));
                confidence += 0.55;
            }

            let config_path = picoclaw_dir.join(PICOCLAW_CONFIG_FILE_NAME);
            if config_path.is_file() {
                evidence.push(format!("found {}", config_path.display()));
                confidence += 0.1;
            }
        }

        if command_exists(PICOCLAW_BINARY, self.path_override.as_deref()) {
            evidence.push("picoclaw binary in PATH".to_string());
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
            "x-webhook-chat-id".to_string(),
            message.recipient_did.clone(),
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
                "metadata": message.metadata,
            }),
        }
    }

    fn default_webhook_port(&self) -> u16 {
        18794
    }

    fn config_path(&self) -> Option<PathBuf> {
        self.resolve_home_dir()
            .map(|home_dir| Self::config_path_from_home(&home_dir))
    }

    fn install(&self, opts: &InstallOptions) -> Result<InstallResult> {
        let home_dir = self.install_home_dir(opts)?;
        let config_path = Self::config_path_from_home(&home_dir);
        let webhook_url = self.resolve_webhook_url(opts)?;

        let mut config = read_json_or_default(&config_path)?;
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
                "token": opts.webhook_token,
                "connectorUrl": opts.connector_url,
            }),
        );

        write_json(&config_path, &config)?;

        Ok(InstallResult {
            platform: self.name().to_string(),
            config_updated: true,
            service_installed: false,
            notes: vec![format!("updated {}", config_path.display())],
        })
    }

    fn verify(&self, _opts: &crate::provider::VerifyOptions) -> Result<VerifyResult> {
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
        let state_dir =
            resolve_state_dir(opts.home_dir.clone().or(self.home_dir_override.clone()))?;

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
                    Some("Run `clawdentity provider setup --for picoclaw`.".to_string()),
                    None,
                );
            }
        }

        let binary_found = command_exists(PICOCLAW_BINARY, self.path_override.as_deref());
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
                "picoclaw binary found in PATH".to_string()
            } else {
                "picoclaw binary not found in PATH".to_string()
            },
            if binary_found {
                None
            } else {
                Some("Install PicoClaw and ensure `picoclaw` is in PATH.".to_string())
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
        let state_dir =
            resolve_state_dir(opts.home_dir.clone().or(self.home_dir_override.clone()))?;
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
            status: ProviderSetupStatus::Ready,
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
        let state_dir =
            resolve_state_dir(opts.home_dir.clone().or(self.home_dir_override.clone()))?;
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
                    "clawdentity-picoclaw-probe-{}",
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

    use super::{PICOCLAW_CONFIG_FILE_NAME, PICOCLAW_DIR_NAME, PicoclawProvider};

    #[test]
    fn detection_checks_home_and_path() {
        let home = TempDir::new().expect("temp home");
        let picoclaw_dir = home.path().join(PICOCLAW_DIR_NAME);
        std::fs::create_dir_all(&picoclaw_dir).expect("picoclaw dir");
        std::fs::write(picoclaw_dir.join(PICOCLAW_CONFIG_FILE_NAME), "{}\n").expect("config");

        let bin_dir = TempDir::new().expect("temp bin");
        std::fs::write(bin_dir.path().join("picoclaw"), "#!/bin/sh\n").expect("binary");

        let provider = PicoclawProvider::with_test_context(
            home.path().to_path_buf(),
            vec![bin_dir.path().to_path_buf()],
        );
        let detection = provider.detect();

        assert!(detection.detected);
        assert!(detection.confidence > 0.8);
        assert!(
            detection
                .evidence
                .iter()
                .any(|entry| entry.contains("picoclaw binary in PATH"))
        );
    }

    #[test]
    fn format_inbound_uses_header_payload_shape() {
        let provider = PicoclawProvider::default();
        let mut metadata = HashMap::new();
        metadata.insert("thread".to_string(), "relay".to_string());

        let request = provider.format_inbound(&InboundMessage {
            sender_did: "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXTB"
                .to_string(),
            recipient_did: "chat-123".to_string(),
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
            request.headers.get("x-webhook-chat-id").map(String::as_str),
            Some("chat-123")
        );
        assert_eq!(
            request.body.get("content").and_then(|value| value.as_str()),
            Some("hello")
        );
    }

    #[test]
    fn config_path_points_to_picoclaw_config() {
        let home = TempDir::new().expect("temp home");
        let provider = PicoclawProvider::with_test_context(home.path().to_path_buf(), Vec::new());

        assert_eq!(
            provider.config_path(),
            Some(
                home.path()
                    .join(PICOCLAW_DIR_NAME)
                    .join(PICOCLAW_CONFIG_FILE_NAME)
            )
        );
    }
}
