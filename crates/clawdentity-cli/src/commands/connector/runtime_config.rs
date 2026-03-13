use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use clawdentity_core::agent::{AgentAuthRecord, inspect_agent};
use clawdentity_core::config::{ConfigPathOptions, get_config_dir, resolve_config};
use clawdentity_core::constants::{AGENTS_DIR, AIT_FILE_NAME, SECRET_KEY_FILE_NAME};
use clawdentity_core::{
    build_relay_connect_headers, fetch_registry_metadata, refresh_agent_auth,
    resolve_openclaw_base_url, resolve_openclaw_hook_token,
};

use super::{ConnectorRuntimeConfig, StartConnectorInput, env_trimmed, normalize_hook_path};

const REGISTRY_AUTH_FILE_NAME: &str = "registry-auth.json";
const ACCESS_TOKEN_REFRESH_LEEWAY_SECONDS: i64 = 60;
const RELAY_CONNECT_PATH: &str = "/v1/relay/connect";

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
    let runtime_inputs = load_runtime_inputs(options, &input.agent_name).await?;
    let proxy_ws_url = resolve_proxy_ws_url(
        input.proxy_ws_url.as_deref(),
        runtime_inputs.config.proxy_url.as_deref(),
        &runtime_inputs.config.registry_url,
    )
    .await?;
    let relay_headers = build_connector_headers(&proxy_ws_url, &runtime_inputs)?;

    Ok(ConnectorRuntimeConfig {
        agent_name: input.agent_name,
        agent_did: runtime_inputs.agent_did,
        proxy_ws_url: proxy_ws_url.clone(),
        relay_headers,
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
        },
        port: input.port,
        bind: input.bind,
    })
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
