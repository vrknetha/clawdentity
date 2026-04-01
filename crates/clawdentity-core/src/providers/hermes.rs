use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::json;

use crate::error::Result;
use crate::http::blocking_client;
use crate::provider::{
    DetectionResult, InboundMessage, InboundRequest, InstallOptions, InstallResult,
    PlatformProvider, ProviderDoctorCheckStatus, ProviderDoctorOptions, ProviderDoctorResult,
    ProviderRelayTestOptions, ProviderRelayTestResult, ProviderRelayTestStatus,
    ProviderSetupOptions, ProviderSetupResult, ProviderSetupStatus, VerifyOptions, VerifyResult,
    check_connector_runtime, command_exists, doctor_status_from_checks,
    load_provider_runtime_config, now_iso, push_doctor_check, read_provider_agent_marker,
    resolve_home_dir_with_fallback, resolve_state_dir, save_provider_runtime_config,
    write_provider_agent_marker,
};

#[path = "hermes_helpers.rs"]
mod hermes_helpers;

const PROVIDER_NAME: &str = "hermes";
const PROVIDER_DISPLAY_NAME: &str = "Hermes";
const HERMES_DIR_NAME: &str = ".hermes";
const HERMES_BINARY: &str = "hermes";
const HERMES_CONFIG_FILE: &str = "config.yaml";
const HERMES_WEBHOOK_PATH: &str = "/webhooks/clawdentity";
const HERMES_ROUTE_NAME: &str = "clawdentity";
const HERMES_DEFAULT_PROMPT: &str = "Agent message from {sender_did}: {message}";
const HERMES_SECRET_BYTES: usize = 32;

struct HermesInstallArtifacts {
    config_path: PathBuf,
    webhook_endpoint: String,
    webhook_secret: String,
    generated_secret: bool,
}

#[derive(Debug, Clone, Default)]
pub struct HermesProvider {
    home_dir_override: Option<PathBuf>,
    path_override: Option<Vec<PathBuf>>,
}

impl HermesProvider {
    fn resolve_home_dir(&self) -> Option<PathBuf> {
        self.home_dir_override.clone().or_else(dirs::home_dir)
    }

    fn config_path_from_home(home_dir: &Path) -> PathBuf {
        home_dir.join(HERMES_DIR_NAME).join(HERMES_CONFIG_FILE)
    }

    fn install_home_dir(&self, opts: &InstallOptions) -> Result<PathBuf> {
        resolve_home_dir_with_fallback(opts.home_dir.as_deref(), self.home_dir_override.as_deref())
    }

    #[cfg(test)]
    fn with_test_context(home_dir: PathBuf, path_override: Vec<PathBuf>) -> Self {
        Self {
            home_dir_override: Some(home_dir),
            path_override: Some(path_override),
        }
    }
}

impl PlatformProvider for HermesProvider {
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
            let hermes_dir = home_dir.join(HERMES_DIR_NAME);
            if hermes_dir.is_dir() {
                evidence.push(format!("found {}/", hermes_dir.display()));
                confidence += 0.6;
            }

            let config_path = hermes_dir.join(HERMES_CONFIG_FILE);
            if config_path.is_file() {
                evidence.push(format!("found {}", config_path.display()));
                confidence += 0.1;
            }
        }

        if command_exists(HERMES_BINARY, self.path_override.as_deref()) {
            evidence.push("hermes binary in PATH".to_string());
            confidence += 0.3;
        }

        DetectionResult {
            detected: confidence > 0.0,
            confidence: confidence.min(1.0),
            evidence,
        }
    }

    fn format_inbound(&self, message: &InboundMessage) -> InboundRequest {
        let session_key = Self::build_session_key(&message.sender_did, &message.metadata);
        let request_id = message
            .request_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| format!("clawdentity-hermes-{}", chrono::Utc::now().timestamp()));
        let mut headers = HashMap::new();
        headers.insert("x-request-id".to_string(), request_id.clone());
        headers.insert("x-webhook-session-key".to_string(), session_key.clone());

        InboundRequest {
            headers,
            body: json!({
                "sender_did": message.sender_did,
                "recipient_did": message.recipient_did,
                "message": message.content,
                "content": message.content,
                "request_id": request_id,
                "session_key": session_key,
                "metadata": message.metadata,
            }),
        }
    }

    fn default_webhook_port(&self) -> u16 {
        8644
    }

    fn config_path(&self) -> Option<PathBuf> {
        self.resolve_home_dir()
            .map(|home_dir| Self::config_path_from_home(&home_dir))
    }

    fn install(&self, opts: &InstallOptions) -> Result<InstallResult> {
        let artifacts = self.configure_install(opts)?;
        let mut notes = vec![format!("updated {}", artifacts.config_path.display())];
        if artifacts.generated_secret {
            notes.push("generated and saved webhook secret".to_string());
        }

        Ok(InstallResult {
            platform: self.name().to_string(),
            config_updated: true,
            service_installed: false,
            notes,
        })
    }

    fn verify(&self, opts: &VerifyOptions) -> Result<VerifyResult> {
        let home_dir = resolve_home_dir_with_fallback(
            opts.home_dir.as_deref(),
            self.home_dir_override.as_deref(),
        )?;
        let config_path = Self::config_path_from_home(&home_dir);
        let config = Self::load_yaml_or_default(&config_path)?;
        let host = Self::configured_webhook_host(&config)
            .unwrap_or_else(|| self.default_webhook_host().to_string());
        let port = Self::configured_webhook_port(&config).unwrap_or(self.default_webhook_port());
        let (healthy, detail) = crate::provider::health_check(&host, port)?;
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

        let home_dir = resolve_home_dir_with_fallback(
            opts.home_dir.as_deref(),
            self.home_dir_override.as_deref(),
        )?;
        let config_path = Self::config_path_from_home(&home_dir);

        let config = if config_path.exists() {
            push_doctor_check(
                &mut checks,
                "config.exists",
                "Config file",
                ProviderDoctorCheckStatus::Pass,
                format!("found {}", config_path.display()),
                None,
                None,
            );
            match Self::load_yaml_or_default(&config_path) {
                Ok(config) => Some(config),
                Err(error) => {
                    push_doctor_check(
                        &mut checks,
                        "config.parse",
                        "Config parse",
                        ProviderDoctorCheckStatus::Fail,
                        error.to_string(),
                        Some("Fix YAML syntax in Hermes config and rerun doctor.".to_string()),
                        None,
                    );
                    None
                }
            }
        } else {
            push_doctor_check(
                &mut checks,
                "config.exists",
                "Config file",
                ProviderDoctorCheckStatus::Fail,
                format!("missing {}", config_path.display()),
                Some("Run `clawdentity provider setup --for hermes`.".to_string()),
                None,
            );
            None
        };

        if let Some(config) = config.as_ref() {
            let route_configured = Self::route_exists(config, HERMES_ROUTE_NAME);
            push_doctor_check(
                &mut checks,
                "config.route",
                "Webhook route",
                if route_configured {
                    ProviderDoctorCheckStatus::Pass
                } else {
                    ProviderDoctorCheckStatus::Fail
                },
                if route_configured {
                    "route `clawdentity` is configured".to_string()
                } else {
                    "route `clawdentity` is missing under platforms.webhook.extra.routes"
                        .to_string()
                },
                if route_configured {
                    None
                } else {
                    Some("Run `clawdentity provider setup --for hermes`.".to_string())
                },
                None,
            );
        }

        let binary_found = command_exists(HERMES_BINARY, self.path_override.as_deref());
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
                "hermes binary found in PATH".to_string()
            } else {
                "hermes binary not found in PATH".to_string()
            },
            if binary_found {
                None
            } else {
                Some("Install Hermes and ensure `hermes` is in PATH.".to_string())
            },
            None,
        );

        let webhook_host = config
            .as_ref()
            .and_then(Self::configured_webhook_host)
            .unwrap_or_else(|| self.default_webhook_host().to_string());
        let webhook_port = config
            .as_ref()
            .and_then(Self::configured_webhook_port)
            .unwrap_or(self.default_webhook_port());
        let (webhook_ok, webhook_detail) =
            crate::provider::health_check(&webhook_host, webhook_port)?;
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
                Some("Start Hermes gateway and verify webhook port settings.".to_string())
            },
            Some(serde_json::json!({ "host": webhook_host, "port": webhook_port })),
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
        let artifacts = self.configure_install(&Self::setup_install_options(opts))?;
        let state_dir =
            resolve_state_dir(opts.home_dir.clone().or(self.home_dir_override.clone()))?;
        let agent_name = Self::resolve_agent_name(opts);
        let marker_path = write_provider_agent_marker(&state_dir, self.name(), &agent_name)?;
        let runtime_path = save_provider_runtime_config(
            &state_dir,
            self.name(),
            Self::build_runtime_config(opts, &artifacts),
        )?;

        Ok(ProviderSetupResult {
            platform: self.name().to_string(),
            status: ProviderSetupStatus::Ready,
            notes: Self::setup_notes(&artifacts, &agent_name),
            updated_paths: vec![
                marker_path.display().to_string(),
                runtime_path.display().to_string(),
                artifacts.config_path.display().to_string(),
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

        let home_dir = resolve_home_dir_with_fallback(
            opts.home_dir.as_deref(),
            self.home_dir_override.as_deref(),
        )?;
        let config_path = Self::config_path_from_home(&home_dir);
        let config = Self::load_yaml_or_default(&config_path)?;

        let endpoint = if let Some(runtime) = runtime.as_ref() {
            runtime.webhook_endpoint.clone()
        } else {
            self.resolve_webhook_url(
                &InstallOptions {
                    home_dir: opts.home_dir.clone(),
                    webhook_port: None,
                    webhook_host: None,
                    webhook_token: None,
                    connector_url: opts.connector_base_url.clone(),
                },
                &config,
            )?
        };

        let webhook_secret = opts
            .webhook_token
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .or_else(|| runtime.as_ref().and_then(|cfg| cfg.webhook_token.clone()))
            .or_else(|| Self::route_secret(&config, HERMES_ROUTE_NAME));

        let Some(webhook_secret) = webhook_secret else {
            return Ok(ProviderRelayTestResult {
                platform: self.name().to_string(),
                status: ProviderRelayTestStatus::Failure,
                checked_at,
                endpoint,
                peer_alias: opts.peer_alias.clone(),
                http_status: None,
                message: "webhook secret is not configured".to_string(),
                remediation_hint: Some(
                    "Run `clawdentity provider setup --for hermes` to generate a secret."
                        .to_string(),
                ),
                preflight,
                details: None,
            });
        };

        let message = opts
            .message
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("clawdentity relay probe");
        let request_id = opts
            .session_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| {
                format!(
                    "clawdentity-hermes-probe-{}",
                    chrono::Utc::now().timestamp()
                )
            });
        let sender_did = opts
            .peer_alias
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| "did:cdi:clawdentity.local:agent:probe".to_string());
        let session_key = format!("peer:{sender_did}");

        let payload = serde_json::json!({
            "sender_did": sender_did,
            "message": message,
            "request_id": request_id,
            "metadata": {
                "peerAlias": opts.peer_alias,
                "source": "clawdentity-provider-relay-test"
            }
        });
        let payload_json = serde_json::to_string(&payload)?;
        let signature = Self::hmac_sha256_hex(&webhook_secret, payload_json.as_bytes());

        let response = match blocking_client()?
            .post(&endpoint)
            .header("content-type", "application/json")
            .header("x-request-id", &request_id)
            .header("x-webhook-session-key", &session_key)
            .header("x-webhook-signature", signature)
            .body(payload_json)
            .send()
        {
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
                        "Verify Hermes gateway is reachable and webhook route is active."
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
                    "Check Hermes webhook route config and signature secret.".to_string(),
                ),
                preflight,
                details: None,
            })
        }
    }
}

#[cfg(test)]
#[path = "hermes_tests.rs"]
mod tests;
