use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::setup::{
    OPENCLAW_DEFAULT_BASE_URL, load_relay_runtime_config, openclaw_agent_name_path,
    read_selected_openclaw_agent, resolve_connector_base_url, resolve_openclaw_hook_token,
};
use crate::constants::{AGENTS_DIR, AIT_FILE_NAME, SECRET_KEY_FILE_NAME};
use crate::db::SqliteStore;
use crate::error::{CoreError, Result};
use crate::http::blocking_client;
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

#[allow(clippy::too_many_lines)]
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

/// TODO(clawdentity): document `run_openclaw_doctor`.
#[allow(clippy::too_many_lines)]
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

    use super::super::setup::{
        OpenclawRelayRuntimeConfig, save_connector_assignment, save_relay_runtime_config,
        write_selected_openclaw_agent,
    };
    use crate::db::SqliteStore;
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
                did: "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4"
                    .to_string(),
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
