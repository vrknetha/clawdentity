use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::doctor::{
    DoctorStatus, OpenclawDoctorOptions, OpenclawDoctorResult, run_openclaw_doctor,
};
use super::setup::{
    read_selected_openclaw_agent, resolve_connector_base_url, resolve_openclaw_base_url,
    resolve_openclaw_hook_token,
};
use crate::db::SqliteStore;
use crate::error::{CoreError, Result};
use crate::http::blocking_client;
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
                did: "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4"
                    .to_string(),
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
