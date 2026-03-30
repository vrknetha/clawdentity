use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use clawdentity_core::agent::{AgentAuthRecord, inspect_agent};
use clawdentity_core::config::{ConfigPathOptions, get_config_dir, resolve_config};
use clawdentity_core::constants::{AGENTS_DIR, AIT_FILE_NAME, SECRET_KEY_FILE_NAME};
use clawdentity_core::{
    SignHttpRequestInput, build_relay_connect_headers, fetch_registry_metadata,
    load_connector_assignments, new_frame_id, parse_agent_did, parse_group_id, refresh_agent_auth,
    resolve_openclaw_base_url, resolve_openclaw_hook_token, sign_http_request,
};

use super::{ConnectorRuntimeConfig, StartConnectorInput, env_trimmed, normalize_hook_path};

const REGISTRY_AUTH_FILE_NAME: &str = "registry-auth.json";
const ACCESS_TOKEN_REFRESH_LEEWAY_SECONDS: i64 = 60;
const RELAY_CONNECT_PATH: &str = "/v1/relay/connect";
const RELAY_DELIVERY_RECEIPTS_PATH: &str = "/v1/relay/delivery-receipts";

struct ConnectorRuntimeInputs {
    config: clawdentity_core::config::CliConfig,
    config_dir: PathBuf,
    agent_auth: AgentAuthRecord,
    agent_did: String,
    ait: String,
    secret_key: String,
}

pub(super) async fn resolve_runtime_config(
    options: &ConfigPathOptions,
    input: StartConnectorInput,
) -> Result<ConnectorRuntimeConfig> {
    enforce_expected_agent_name(&input.agent_name)?;
    let runtime_inputs = load_runtime_inputs(options, &input.agent_name).await?;
    let proxy_ws_url = resolve_proxy_ws_url(
        input.proxy_ws_url.as_deref(),
        runtime_inputs.config.proxy_url.as_deref(),
        &runtime_inputs.config.registry_url,
    )
    .await?;
    let proxy_receipt_url = resolve_proxy_receipt_url(&proxy_ws_url)?;
    let config_dir = runtime_inputs.config_dir.clone();
    let target_agent_id =
        resolve_openclaw_target_agent_id(&runtime_inputs.config_dir, &input.agent_name)?;

    Ok(ConnectorRuntimeConfig {
        agent_name: input.agent_name,
        agent_did: runtime_inputs.agent_did,
        config_dir,
        proxy_receipt_url,
        proxy_ws_url,
        openclaw_runtime: clawdentity_core::runtime_openclaw::OpenclawRuntimeConfig {
            base_url: resolve_openclaw_base_url(
                &runtime_inputs.config_dir,
                input.openclaw_base_url.as_deref(),
            )?,
            hook_path: resolve_openclaw_hook_path(input.openclaw_hook_path.as_deref()),
            hook_token: resolve_openclaw_hook_token(
                &runtime_inputs.config_dir,
                input.openclaw_hook_token.as_deref(),
            )?,
            target_agent_id,
        },
        port: input.port,
        bind: input.bind,
    })
}

fn expected_agent_name_from_env() -> Option<String> {
    env_trimmed("CLAWDENTITY_EXPECTED_AGENT_NAME")
}

pub(super) fn validate_expected_agent_name(
    agent_name: &str,
    expected_agent_name: Option<&str>,
) -> Result<()> {
    let selected = agent_name.trim();
    let expected = expected_agent_name
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(expected) = expected else {
        return Ok(());
    };

    if selected == expected {
        return Ok(());
    }

    Err(anyhow!(
        "connector startup blocked for agent `{selected}`: this environment expects `{expected}`. Start the connector with `clawdentity connector start {expected}` or re-run onboarding so container ownership matches."
    ))
}

fn enforce_expected_agent_name(agent_name: &str) -> Result<()> {
    validate_expected_agent_name(agent_name, expected_agent_name_from_env().as_deref())
}

pub(super) fn resolve_openclaw_target_agent_id(
    config_dir: &Path,
    agent_name: &str,
) -> Result<Option<String>> {
    let assignments = load_connector_assignments(config_dir)?;
    Ok(assignments
        .agents
        .get(agent_name)
        .and_then(|assignment| assignment.openclaw_agent_id.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned))
}

pub(super) fn load_connector_headers(
    options: &ConfigPathOptions,
    agent_name: &str,
    proxy_ws_url: &str,
) -> Result<Vec<(String, String)>> {
    let runtime_inputs = resolve_runtime_inputs(options, agent_name)?;
    build_connector_headers(proxy_ws_url, &runtime_inputs)
}

async fn load_runtime_inputs(
    options: &ConfigPathOptions,
    agent_name: &str,
) -> Result<ConnectorRuntimeInputs> {
    let blocking_options = options.clone();
    let blocking_agent_name = agent_name.to_string();
    tokio::task::spawn_blocking(move || {
        resolve_runtime_inputs(&blocking_options, &blocking_agent_name)
    })
    .await
    .map_err(|error| anyhow!("failed to resolve connector runtime inputs: {error}"))?
}

fn resolve_runtime_inputs(
    options: &ConfigPathOptions,
    agent_name: &str,
) -> Result<ConnectorRuntimeInputs> {
    let config = resolve_config(options)?;
    let config_dir = get_config_dir(options)?;
    let inspect = inspect_agent(options, agent_name)
        .with_context(|| format!("failed to inspect agent `{agent_name}`"))?;
    let agent_dir = config_dir.join(AGENTS_DIR).join(agent_name);

    Ok(ConnectorRuntimeInputs {
        config,
        config_dir: config_dir.clone(),
        agent_auth: load_connector_agent_auth(options, agent_name, &config_dir)?,
        agent_did: inspect.did,
        ait: read_required_trimmed_file(&agent_dir.join(AIT_FILE_NAME), AIT_FILE_NAME)?,
        secret_key: read_required_trimmed_file(
            &agent_dir.join(SECRET_KEY_FILE_NAME),
            SECRET_KEY_FILE_NAME,
        )?,
    })
}

fn build_connector_headers(
    proxy_ws_url: &str,
    runtime_inputs: &ConnectorRuntimeInputs,
) -> Result<Vec<(String, String)>> {
    let signing_key = clawdentity_core::decode_secret_key(&runtime_inputs.secret_key)?;
    let relay_headers =
        build_relay_connect_headers(proxy_ws_url, &runtime_inputs.ait, &signing_key)?;
    let mut connector_headers = Vec::with_capacity(relay_headers.signed_headers.len() + 1);
    connector_headers.push(("authorization".to_string(), relay_headers.authorization));
    connector_headers.push((
        "x-claw-agent-access".to_string(),
        runtime_inputs.agent_auth.access_token.clone(),
    ));
    connector_headers.extend(relay_headers.signed_headers);
    Ok(connector_headers)
}

fn load_connector_agent_auth(
    options: &ConfigPathOptions,
    agent_name: &str,
    config_dir: &Path,
) -> Result<AgentAuthRecord> {
    let auth_path = config_dir
        .join(AGENTS_DIR)
        .join(agent_name)
        .join(REGISTRY_AUTH_FILE_NAME);

    let mut record = read_agent_auth_record(&auth_path)?;
    if agent_access_requires_refresh(&record, Utc::now()) {
        refresh_agent_auth(options, agent_name)
            .with_context(|| format!("failed to refresh agent auth for `{agent_name}`"))?;
        record = read_agent_auth_record(&auth_path)?;
    }

    if record.access_token.trim().is_empty() {
        return Err(anyhow!(
            "agent registry auth is invalid for connector startup: access token is missing"
        ));
    }

    Ok(record)
}

fn read_agent_auth_record(path: &Path) -> Result<AgentAuthRecord> {
    let raw =
        fs::read_to_string(path).with_context(|| format!("failed to read {}", path.display()))?;
    serde_json::from_str::<AgentAuthRecord>(&raw)
        .with_context(|| format!("failed to parse {}", path.display()))
}

pub(super) fn agent_access_requires_refresh(record: &AgentAuthRecord, now: DateTime<Utc>) -> bool {
    if record.access_token.trim().is_empty() {
        return true;
    }

    match DateTime::parse_from_rfc3339(record.access_expires_at.trim()) {
        Ok(expires_at) => {
            expires_at.with_timezone(&Utc)
                <= now + ChronoDuration::seconds(ACCESS_TOKEN_REFRESH_LEEWAY_SECONDS)
        }
        Err(_) => true,
    }
}

fn read_required_trimmed_file(path: &Path, label: &str) -> Result<String> {
    let value = fs::read_to_string(path)
        .with_context(|| format!("failed to read {} at {}", label, path.display()))?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("{label} is empty at {}", path.display()));
    }
    Ok(trimmed.to_string())
}

fn resolve_openclaw_hook_path(explicit: Option<&str>) -> String {
    explicit
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(normalize_hook_path)
        .or_else(|| env_trimmed("OPENCLAW_HOOK_PATH").map(|value| normalize_hook_path(&value)))
        .unwrap_or_else(|| normalize_hook_path(super::DEFAULT_OPENCLAW_HOOK_PATH))
}

async fn resolve_proxy_ws_url(
    explicit_proxy_ws_url: Option<&str>,
    config_proxy_url: Option<&str>,
    registry_url: &str,
) -> Result<String> {
    if let Some(value) = explicit_proxy_ws_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return normalize_proxy_ws_url(value);
    }
    if let Some(value) = env_trimmed("CLAWDENTITY_PROXY_WS_URL") {
        return normalize_proxy_ws_url(&value);
    }
    if let Some(value) = env_trimmed("CLAWDENTITY_PROXY_URL") {
        return normalize_proxy_ws_url(&value);
    }
    if let Some(value) = config_proxy_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return normalize_proxy_ws_url(value);
    }

    let metadata_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| anyhow!("failed to create metadata client: {error}"))?;
    let metadata = fetch_registry_metadata(&metadata_client, registry_url)
        .await
        .map_err(anyhow::Error::from)?;

    if metadata.proxy_url.trim().is_empty() {
        return Err(anyhow!(
            "proxy URL is required for connector startup; set --proxy-ws-url, CLAWDENTITY_PROXY_WS_URL, or CLAWDENTITY_PROXY_URL"
        ));
    }

    normalize_proxy_ws_url(&metadata.proxy_url)
}

pub(super) fn normalize_proxy_ws_url(value: &str) -> Result<String> {
    let mut url =
        reqwest::Url::parse(value).map_err(|_| anyhow!("invalid proxy websocket URL: {value}"))?;
    let target_scheme = match url.scheme() {
        "ws" | "wss" => None,
        "http" => Some("ws"),
        "https" => Some("wss"),
        _ => return Err(anyhow!("invalid proxy websocket scheme in {value}")),
    };

    if let Some(scheme) = target_scheme {
        url.set_scheme(scheme)
            .map_err(|_| anyhow!("failed to normalize proxy websocket scheme for {value}"))?;
    }
    if url.path().trim().is_empty() || url.path() == "/" {
        url.set_path(RELAY_CONNECT_PATH);
    }
    Ok(url.to_string())
}

pub(super) fn resolve_proxy_receipt_url(proxy_ws_url: &str) -> Result<String> {
    let mut url = reqwest::Url::parse(proxy_ws_url)
        .map_err(|_| anyhow!("invalid proxy websocket URL: {proxy_ws_url}"))?;
    match url.scheme() {
        "ws" => {
            url.set_scheme("http")
                .map_err(|_| anyhow!("failed to normalize receipt URL scheme"))?;
        }
        "wss" => {
            url.set_scheme("https")
                .map_err(|_| anyhow!("failed to normalize receipt URL scheme"))?;
        }
        "http" | "https" => {}
        _ => return Err(anyhow!("invalid proxy websocket scheme in {proxy_ws_url}")),
    }
    url.set_path(RELAY_DELIVERY_RECEIPTS_PATH);
    url.set_query(None);
    Ok(url.to_string())
}

fn to_path_with_query(url: &reqwest::Url) -> String {
    match url.query() {
        Some(query) if !query.is_empty() => format!("{}?{query}", url.path()),
        _ => url.path().to_string(),
    }
}

fn build_signed_registry_request_headers(
    runtime_inputs: &ConnectorRuntimeInputs,
    method: &str,
    request_url: &reqwest::Url,
    body: &[u8],
) -> Result<Vec<(String, String)>> {
    let signing_key = clawdentity_core::decode_secret_key(&runtime_inputs.secret_key)?;
    let timestamp = Utc::now().timestamp().to_string();
    let nonce = new_frame_id();
    let signed = sign_http_request(&SignHttpRequestInput {
        method,
        path_with_query: &to_path_with_query(request_url),
        timestamp: &timestamp,
        nonce: &nonce,
        body,
        secret_key: &signing_key,
    })?;

    let mut headers = Vec::with_capacity(signed.headers.len() + 2);
    headers.push((
        "authorization".to_string(),
        format!("Claw {}", runtime_inputs.ait.trim()),
    ));
    headers.push((
        "x-claw-agent-access".to_string(),
        runtime_inputs.agent_auth.access_token.clone(),
    ));
    headers.extend(signed.headers);
    Ok(headers)
}

#[allow(clippy::too_many_lines)]
pub(super) async fn fetch_group_member_dids(
    options: &ConfigPathOptions,
    agent_name: &str,
    group_id: &str,
) -> Result<Vec<String>> {
    let normalized_group_id =
        parse_group_id(group_id).map_err(|error| anyhow!("groupId is invalid: {error}"))?;
    let runtime_inputs = load_runtime_inputs(options, agent_name).await?;

    let base_registry_url = reqwest::Url::parse(runtime_inputs.config.registry_url.trim())
        .map_err(|error| anyhow!("registry URL is invalid: {error}"))?;
    let request_url = base_registry_url
        .join(&format!("/v1/groups/{normalized_group_id}/members"))
        .map_err(|error| anyhow!("group members URL is invalid: {error}"))?;

    let headers = build_signed_registry_request_headers(&runtime_inputs, "GET", &request_url, &[])?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| anyhow!("failed to create group membership client: {error}"))?;
    let mut request = client.get(request_url);
    for (name, value) in headers {
        request = request.header(name, value);
    }

    let response = request
        .send()
        .await
        .map_err(|error| anyhow!("group membership lookup failed: {error}"))?;

    if response.status() == reqwest::StatusCode::UNAUTHORIZED
        || response.status() == reqwest::StatusCode::FORBIDDEN
    {
        return Err(anyhow!("group membership lookup is unauthorized"));
    }
    if !response.status().is_success() {
        return Err(anyhow!(
            "group membership lookup failed with status {}",
            response.status()
        ));
    }

    let payload: serde_json::Value = response
        .json()
        .await
        .map_err(|error| anyhow!("group membership response is invalid: {error}"))?;
    let members = payload
        .get("members")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| anyhow!("group membership response is invalid"))?;

    let mut member_dids: Vec<String> = Vec::new();
    for member in members {
        let did = member
            .get("agentDid")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| anyhow!("group membership response is invalid"))?;
        parse_agent_did(did)
            .map_err(|error| anyhow!("group membership response is invalid: {error}"))?;
        member_dids.push(did.to_string());
    }

    Ok(member_dids)
}

pub(super) fn load_receipt_post_headers(
    options: &ConfigPathOptions,
    agent_name: &str,
    receipt_url: &str,
    body: &[u8],
) -> Result<Vec<(String, String)>> {
    let runtime_inputs = resolve_runtime_inputs(options, agent_name)?;
    let signing_key = clawdentity_core::decode_secret_key(&runtime_inputs.secret_key)?;
    let parsed_url = reqwest::Url::parse(receipt_url)
        .map_err(|_| anyhow!("invalid proxy receipt URL: {receipt_url}"))?;
    let timestamp = Utc::now().timestamp().to_string();
    let nonce = new_frame_id();
    let signed = sign_http_request(&SignHttpRequestInput {
        method: "POST",
        path_with_query: &to_path_with_query(&parsed_url),
        timestamp: &timestamp,
        nonce: &nonce,
        body,
        secret_key: &signing_key,
    })?;

    let mut headers = Vec::with_capacity(signed.headers.len() + 2);
    headers.push((
        "authorization".to_string(),
        format!("Claw {}", runtime_inputs.ait),
    ));
    headers.push((
        "x-claw-agent-access".to_string(),
        runtime_inputs.agent_auth.access_token.clone(),
    ));
    headers.extend(signed.headers);
    Ok(headers)
}
