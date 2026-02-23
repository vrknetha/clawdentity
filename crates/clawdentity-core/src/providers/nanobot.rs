use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::json;

use crate::error::Result;
use crate::http::blocking_client;
use crate::provider::{
    DetectionResult, InboundMessage, InboundRequest, InstallOptions, InstallResult,
    PlatformProvider, ProviderDoctorCheckStatus, ProviderDoctorOptions, ProviderDoctorResult,
    ProviderRelayRuntimeConfig, ProviderRelayTestOptions, ProviderRelayTestResult,
    ProviderRelayTestStatus, ProviderSetupOptions, ProviderSetupResult, VerifyResult,
    check_connector_runtime, command_exists, default_webhook_url, doctor_status_from_checks,
    ensure_json_object_path, health_check, join_url_path, load_provider_runtime_config, now_iso,
    push_doctor_check, read_json_or_default, read_provider_agent_marker, read_text,
    resolve_home_dir_with_fallback, resolve_state_dir, save_provider_runtime_config,
    upsert_marked_block, write_json, write_provider_agent_marker, write_text,
};

const PROVIDER_NAME: &str = "nanobot";
const PROVIDER_DISPLAY_NAME: &str = "NanoBot";
const NANOBOT_DIR_NAME: &str = ".nanobot";
const NANOBOT_CONFIG_YAML_FILE_NAME: &str = "config.yaml";
const NANOBOT_CONFIG_JSON_FILE_NAME: &str = "config.json";
const NANOBOT_BINARY: &str = "nanobot";
const NANOBOT_WEBHOOK_PATH: &str = "/v1/inbound";
const NANOBOT_MARKER_START: &str = "# >>> clawdentity nanobot webhook >>>";
const NANOBOT_MARKER_END: &str = "# <<< clawdentity nanobot webhook <<<";

#[derive(Debug, Clone, Default)]
pub struct NanobotProvider {
    home_dir_override: Option<PathBuf>,
    path_override: Option<Vec<PathBuf>>,
}

impl NanobotProvider {
    fn resolve_home_dir(&self) -> Option<PathBuf> {
        self.home_dir_override.clone().or_else(dirs::home_dir)
    }

    fn config_path_from_home(home_dir: &Path) -> PathBuf {
        let dir = home_dir.join(NANOBOT_DIR_NAME);
        let yaml_path = dir.join(NANOBOT_CONFIG_YAML_FILE_NAME);
        if yaml_path.exists() {
            return yaml_path;
        }

        let json_path = dir.join(NANOBOT_CONFIG_JSON_FILE_NAME);
        if json_path.exists() {
            return json_path;
        }

        yaml_path
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
            return join_url_path(connector_url, NANOBOT_WEBHOOK_PATH, "connectorUrl");
        }

        let host = opts
            .webhook_host
            .as_deref()
            .unwrap_or(self.default_webhook_host());
        let port = opts.webhook_port.unwrap_or(self.default_webhook_port());
        default_webhook_url(host, port, NANOBOT_WEBHOOK_PATH)
    }

    #[cfg(test)]
    fn with_test_context(home_dir: PathBuf, path_override: Vec<PathBuf>) -> Self {
        Self {
            home_dir_override: Some(home_dir),
            path_override: Some(path_override),
        }
    }
}

impl PlatformProvider for NanobotProvider {
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
            let nanobot_dir = home_dir.join(NANOBOT_DIR_NAME);
            if nanobot_dir.is_dir() {
                evidence.push(format!("found {}/", nanobot_dir.display()));
                confidence += 0.6;
            }

            let yaml_path = nanobot_dir.join(NANOBOT_CONFIG_YAML_FILE_NAME);
            if yaml_path.is_file() {
                evidence.push(format!("found {}", yaml_path.display()));
                confidence += 0.05;
            }

            let json_path = nanobot_dir.join(NANOBOT_CONFIG_JSON_FILE_NAME);
            if json_path.is_file() {
                evidence.push(format!("found {}", json_path.display()));
                confidence += 0.05;
            }
        }

        if command_exists(NANOBOT_BINARY, self.path_override.as_deref()) {
            evidence.push("nanobot binary in PATH".to_string());
            confidence += 0.3;
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
        self.resolve_home_dir()
            .map(|home_dir| Self::config_path_from_home(&home_dir))
    }

    fn install(&self, opts: &InstallOptions) -> Result<InstallResult> {
        let home_dir = self.install_home_dir(opts)?;
        let config_path = Self::config_path_from_home(&home_dir);
        let webhook_url = self.resolve_webhook_url(opts)?;

        let config_extension = config_path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();

        if config_extension.eq_ignore_ascii_case("json") {
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
        } else {
            let existing = read_text(&config_path)?.unwrap_or_default();
            let block = format!(
                "{NANOBOT_MARKER_START}\nclawdentity:\n  provider: {PROVIDER_NAME}\n  webhook:\n    enabled: true\n    url: \"{webhook_url}\"\n    host: \"{}\"\n    port: {}\n{}{}\n{NANOBOT_MARKER_END}\n",
                opts.webhook_host
                    .as_deref()
                    .unwrap_or(self.default_webhook_host()),
                opts.webhook_port.unwrap_or(self.default_webhook_port()),
                opts.webhook_token
                    .as_deref()
                    .map(|token| format!("    token: \"{token}\"\n"))
                    .unwrap_or_default(),
                opts.connector_url
                    .as_deref()
                    .map(|connector_url| { format!("    connectorUrl: \"{connector_url}\"\n") })
                    .unwrap_or_default()
            );
            let merged =
                upsert_marked_block(&existing, NANOBOT_MARKER_START, NANOBOT_MARKER_END, &block);
            write_text(&config_path, &merged)?;
        }

        Ok(InstallResult {
            platform: self.name().to_string(),
            config_updated: true,
            service_installed: false,
            notes: vec![format!("updated {}", config_path.display())],
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
                    Some("Run `clawdentity provider setup --for nanobot`.".to_string()),
                    None,
                );
            }
        }

        let binary_found = command_exists(NANOBOT_BINARY, self.path_override.as_deref());
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
                "nanobot binary found in PATH".to_string()
            } else {
                "nanobot binary not found in PATH".to_string()
            },
            if binary_found {
                None
            } else {
                Some("Install NanoBot and ensure `nanobot` is in PATH.".to_string())
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
            notes,
            updated_paths: vec![
                marker_path.display().to_string(),
                runtime_path.display().to_string(),
            ],
        })
    }

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
                    "clawdentity-nanobot-probe-{}",
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

    use super::{NANOBOT_CONFIG_YAML_FILE_NAME, NANOBOT_DIR_NAME, NanobotProvider};

    #[test]
    fn detection_checks_home_and_path() {
        let home = TempDir::new().expect("temp home");
        let nanobot_dir = home.path().join(NANOBOT_DIR_NAME);
        std::fs::create_dir_all(&nanobot_dir).expect("nanobot dir");
        std::fs::write(nanobot_dir.join(NANOBOT_CONFIG_YAML_FILE_NAME), "{}\n").expect("config");

        let bin_dir = TempDir::new().expect("temp bin");
        std::fs::write(bin_dir.path().join("nanobot"), "#!/bin/sh\n").expect("binary");

        let provider = NanobotProvider::with_test_context(
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
                .any(|entry| entry.contains("nanobot binary in PATH"))
        );
    }

    #[test]
    fn format_inbound_uses_body_payload_shape() {
        let provider = NanobotProvider::default();

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
    fn config_path_defaults_to_nanobot_yaml() {
        let home = TempDir::new().expect("temp home");
        let provider = NanobotProvider::with_test_context(home.path().to_path_buf(), Vec::new());

        assert_eq!(
            provider.config_path(),
            Some(
                home.path()
                    .join(NANOBOT_DIR_NAME)
                    .join(NANOBOT_CONFIG_YAML_FILE_NAME)
            )
        );
    }
}
