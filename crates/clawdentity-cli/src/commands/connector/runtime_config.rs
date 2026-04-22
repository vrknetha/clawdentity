use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use clawdentity_core::agent::{AgentAuthRecord, inspect_agent};
use clawdentity_core::config::{ConfigPathOptions, get_config_dir, resolve_config};
use clawdentity_core::constants::{AGENTS_DIR, AIT_FILE_NAME, SECRET_KEY_FILE_NAME};
use clawdentity_core::{
    SignHttpRequestInput, build_relay_connect_headers, fetch_group_member_dids_with_agent_auth,
    fetch_group_name_with_agent_auth,
    fetch_registry_agent_profile as fetch_registry_agent_profile_with_agent_auth,
    fetch_registry_metadata, new_frame_id, parse_agent_did, parse_group_id, refresh_agent_auth,
    sign_http_request,
};
use serde::{Deserialize, Serialize};

use super::{ConnectorRuntimeConfig, StartConnectorInput, env_trimmed};

const REGISTRY_AUTH_FILE_NAME: &str = "registry-auth.json";
const DELIVERY_CONFIG_FILE_NAME: &str = "delivery-webhook.json";
const ACCESS_TOKEN_REFRESH_LEEWAY_SECONDS: i64 = 60;
const GROUP_NAME_CACHE_TTL_MS: i64 = 60_000;
const RUNTIME_INPUTS_CACHE_TTL_MS: i64 = 5_000;
const RELAY_CONNECT_PATH: &str = "/v1/relay/connect";
const RELAY_DELIVERY_RECEIPTS_PATH: &str = "/v1/relay/delivery-receipts";
const RESERVED_DELIVERY_WEBHOOK_HEADER_PREFIXES: &[&str] = &["x-clawdentity-"];
const RESERVED_DELIVERY_WEBHOOK_HEADER_NAMES: &[&str] = &[
    "authorization",
    "content-type",
    "host",
    "connection",
    "content-length",
    "transfer-encoding",
    "x-request-id",
];
static GROUP_NAME_CACHE: OnceLock<Mutex<HashMap<String, CachedGroupName>>> = OnceLock::new();
static RUNTIME_INPUTS_CACHE: OnceLock<Mutex<HashMap<String, CachedRuntimeInputs>>> =
    OnceLock::new();

#[derive(Debug, Clone)]
struct CachedGroupName {
    name: String,
    expires_at_ms: i64,
}

#[derive(Debug, Clone)]
struct CachedRuntimeInputs {
    inputs: ConnectorRuntimeInputs,
    expires_at_ms: i64,
}

fn group_name_cache() -> &'static Mutex<HashMap<String, CachedGroupName>> {
    GROUP_NAME_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn runtime_inputs_cache() -> &'static Mutex<HashMap<String, CachedRuntimeInputs>> {
    RUNTIME_INPUTS_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lookup_cached_group_name(group_id: &str, now_ms: i64) -> Option<String> {
    let cache = group_name_cache().lock().ok()?;
    let entry = cache.get(group_id)?;
    if entry.expires_at_ms <= now_ms {
        return None;
    }

    Some(entry.name.clone())
}

fn lookup_stale_cached_group_name(group_id: &str) -> Option<String> {
    let cache = group_name_cache().lock().ok()?;
    cache.get(group_id).map(|entry| entry.name.clone())
}

fn remember_group_name(group_id: &str, name: &str, now_ms: i64) {
    if let Ok(mut cache) = group_name_cache().lock() {
        cache.retain(|_, entry| entry.expires_at_ms > now_ms);
        cache.insert(
            group_id.to_string(),
            CachedGroupName {
                name: name.to_string(),
                expires_at_ms: now_ms + GROUP_NAME_CACHE_TTL_MS,
            },
        );
    }
}

fn runtime_inputs_cache_key(options: &ConfigPathOptions, agent_name: &str) -> String {
    let home_dir = options
        .home_dir
        .as_deref()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    let registry_url_hint = options.registry_url_hint.clone().unwrap_or_default();
    format!("{agent_name}|{home_dir}|{registry_url_hint}")
}

fn lookup_cached_runtime_inputs(
    options: &ConfigPathOptions,
    agent_name: &str,
    now_ms: i64,
) -> Option<ConnectorRuntimeInputs> {
    let cache_key = runtime_inputs_cache_key(options, agent_name);
    let cache = runtime_inputs_cache().lock().ok()?;
    let entry = cache.get(&cache_key)?;
    if entry.expires_at_ms <= now_ms {
        return None;
    }

    Some(entry.inputs.clone())
}

fn remember_runtime_inputs(
    options: &ConfigPathOptions,
    agent_name: &str,
    inputs: &ConnectorRuntimeInputs,
    now_ms: i64,
) {
    if let Ok(mut cache) = runtime_inputs_cache().lock() {
        cache.retain(|_, entry| entry.expires_at_ms > now_ms);
        cache.insert(
            runtime_inputs_cache_key(options, agent_name),
            CachedRuntimeInputs {
                inputs: inputs.clone(),
                expires_at_ms: now_ms + RUNTIME_INPUTS_CACHE_TTL_MS,
            },
        );
    }
}

#[derive(Debug, Clone)]
struct ConnectorRuntimeInputs {
    config: clawdentity_core::config::CliConfig,
    config_dir: PathBuf,
    agent_auth: AgentAuthRecord,
    agent_did: String,
    ait: String,
    secret_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AgentDeliveryConfig {
    pub(super) delivery_webhook_url: String,
    #[serde(default)]
    pub(super) delivery_webhook_headers: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) delivery_health_url: Option<String>,
}

#[allow(clippy::too_many_lines)]
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
    let saved_delivery_config = load_agent_delivery_config_from_dir(&config_dir, &input.agent_name)?;
    let delivery_webhook_url = input
        .delivery_webhook_url
        .clone()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            saved_delivery_config
                .as_ref()
                .map(|config| config.delivery_webhook_url.trim().to_string())
                .filter(|value| !value.is_empty())
        })
        .ok_or_else(|| {
            anyhow!(
                "delivery webhook URL is required. Run `clawdentity connector configure {}` first or pass --delivery-webhook-url.",
                input.agent_name
            )
        })?;
    let delivery_webhook_url = normalize_and_validate_delivery_webhook_url(&delivery_webhook_url)?;
    let delivery_webhook_headers = if input.delivery_webhook_headers.is_empty() {
        saved_delivery_config
            .as_ref()
            .map(|config| config.delivery_webhook_headers.clone())
            .unwrap_or_default()
    } else {
        input.delivery_webhook_headers.clone()
    };
    let parsed_delivery_webhook_headers =
        parse_delivery_webhook_headers(&delivery_webhook_headers)?;
    let delivery_health_url = input
        .delivery_health_url
        .clone()
        .or_else(|| {
            saved_delivery_config
                .as_ref()
                .and_then(|config| config.delivery_health_url.clone())
        });
    let delivery_health_url =
        normalize_optional_delivery_health_url(delivery_health_url.as_deref())?;

    Ok(ConnectorRuntimeConfig {
        agent_name: input.agent_name,
        agent_did: runtime_inputs.agent_did,
        config_dir,
        proxy_receipt_url,
        proxy_ws_url,
        delivery_webhook_runtime: clawdentity_core::runtime_webhook::DeliveryWebhookRuntimeConfig {
            webhook_url: delivery_webhook_url,
            health_url: delivery_health_url,
            webhook_headers: parsed_delivery_webhook_headers,
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

fn delivery_config_path(
    config_dir: &Path,
    agent_name: &str,
) -> PathBuf {
    config_dir
        .join(AGENTS_DIR)
        .join(agent_name)
        .join(DELIVERY_CONFIG_FILE_NAME)
}

fn parse_delivery_webhook_headers(headers: &[String]) -> Result<Vec<(String, String)>> {
    let mut parsed_headers = Vec::new();
    for header in headers {
        let candidate = header.trim();
        if candidate.is_empty() {
            continue;
        }
        let Some((name, value)) = candidate.split_once(':') else {
            return Err(anyhow!(
                "invalid delivery webhook header `{candidate}`. Expected `Name: value`."
            ));
        };
        let name = name.trim();
        let value = value.trim();
        if name.is_empty() || value.is_empty() {
            return Err(anyhow!(
                "invalid delivery webhook header `{candidate}`. Header name and value are required."
            ));
        }
        let header_name = reqwest::header::HeaderName::from_bytes(name.as_bytes()).map_err(|_| {
            anyhow!("invalid delivery webhook header `{candidate}`. Header name is invalid.")
        })?;
        reqwest::header::HeaderValue::from_str(value).map_err(|_| {
            anyhow!("invalid delivery webhook header `{candidate}`. Header value is invalid.")
        })?;
        let normalized_name = header_name.as_str().to_ascii_lowercase();
        if is_reserved_delivery_webhook_header(&normalized_name) {
            return Err(anyhow!(
                "invalid delivery webhook header `{candidate}`. `{normalized_name}` is reserved and cannot be overridden."
            ));
        }
        parsed_headers.push((normalized_name, value.to_string()));
    }
    Ok(parsed_headers)
}

fn normalize_and_validate_delivery_webhook_url(value: &str) -> Result<String> {
    let runtime = clawdentity_core::runtime_webhook::DeliveryWebhookRuntimeConfig {
        webhook_url: value.trim().to_string(),
        health_url: None,
        webhook_headers: Vec::new(),
    };
    runtime
        .validated_webhook_url()
        .map_err(anyhow::Error::from)
}

fn normalize_optional_delivery_health_url(value: Option<&str>) -> Result<Option<String>> {
    let Some(raw) = value.map(str::trim).filter(|candidate| !candidate.is_empty()) else {
        return Ok(None);
    };
    let parsed = reqwest::Url::parse(raw)
        .map_err(|_| anyhow!("invalid delivery health URL: {raw}"))?;
    match parsed.scheme() {
        "http" | "https" => Ok(Some(parsed.to_string())),
        _ => Err(anyhow!("delivery health URL must use http or https")),
    }
}

fn is_reserved_delivery_webhook_header(name: &str) -> bool {
    RESERVED_DELIVERY_WEBHOOK_HEADER_NAMES.contains(&name)
        || RESERVED_DELIVERY_WEBHOOK_HEADER_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix))
}

fn redact_delivery_webhook_headers(headers: &[String]) -> Vec<String> {
    headers
        .iter()
        .map(|header| {
            let trimmed = header.trim();
            if let Some((name, _)) = trimmed.split_once(':') {
                let sanitized_name = name.trim();
                if sanitized_name.is_empty() {
                    "[REDACTED]".to_string()
                } else {
                    format!("{sanitized_name}: [REDACTED]")
                }
            } else {
                "[REDACTED]".to_string()
            }
        })
        .collect()
}

fn redact_webhook_url_for_output(url: &str) -> String {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let Ok(mut parsed) = reqwest::Url::parse(trimmed) else {
        return trimmed.to_string();
    };
    let _ = parsed.set_username("");
    let _ = parsed.set_password(None);
    parsed.set_query(None);
    parsed.set_fragment(None);
    parsed.to_string()
}

fn write_delivery_config_file(path: &Path, body: &str) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        use std::os::unix::fs::PermissionsExt;

        let mut file = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(path)
            .with_context(|| format!("failed to write connector delivery config {}", path.display()))?;
        file.write_all(body.as_bytes())
            .with_context(|| format!("failed to write connector delivery config {}", path.display()))?;
        file.write_all(b"\n")
            .with_context(|| format!("failed to write connector delivery config {}", path.display()))?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .with_context(|| format!("failed to secure connector delivery config {}", path.display()))?;
        Ok(())
    }

    #[cfg(not(unix))]
    {
        fs::write(path, format!("{body}\n"))
            .with_context(|| format!("failed to write connector delivery config {}", path.display()))?;
        Ok(())
    }
}

pub(super) fn load_agent_delivery_config(
    options: &ConfigPathOptions,
    agent_name: &str,
) -> Result<Option<AgentDeliveryConfig>> {
    let config_dir = get_config_dir(options)?;
    load_agent_delivery_config_from_dir(&config_dir, agent_name)
}

fn load_agent_delivery_config_from_dir(
    config_dir: &Path,
    agent_name: &str,
) -> Result<Option<AgentDeliveryConfig>> {
    let path = delivery_config_path(config_dir, agent_name);
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(anyhow!(
                "failed to read connector delivery config at {}: {error}",
                path.display()
            ));
        }
    };
    let parsed = serde_json::from_str::<AgentDeliveryConfig>(&raw).map_err(|error| {
        anyhow!(
            "failed to parse connector delivery config at {}: {error}",
            path.display()
        )
    })?;
    Ok(Some(parsed))
}

pub(super) fn save_agent_delivery_config(
    options: &ConfigPathOptions,
    agent_name: &str,
    config: &AgentDeliveryConfig,
    json_output: bool,
) -> Result<()> {
    let normalized_delivery_webhook_url =
        normalize_and_validate_delivery_webhook_url(&config.delivery_webhook_url)?;
    let normalized_delivery_health_url =
        normalize_optional_delivery_health_url(config.delivery_health_url.as_deref())?;
    parse_delivery_webhook_headers(&config.delivery_webhook_headers)?;
    let normalized_config = AgentDeliveryConfig {
        delivery_webhook_url: normalized_delivery_webhook_url,
        delivery_webhook_headers: config.delivery_webhook_headers.clone(),
        delivery_health_url: normalized_delivery_health_url,
    };
    let config_dir = get_config_dir(options)?;
    let path = delivery_config_path(&config_dir, agent_name);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!(
                "failed to create connector delivery config directory {}",
                parent.display()
            )
        })?;
    }
    let body = serde_json::to_string_pretty(&normalized_config)?;
    write_delivery_config_file(&path, &body)?;
    let redacted_headers = redact_delivery_webhook_headers(&normalized_config.delivery_webhook_headers);
    let redacted_webhook_url = redact_webhook_url_for_output(&normalized_config.delivery_webhook_url);
    let redacted_health_url = normalized_config
        .delivery_health_url
        .as_deref()
        .map(redact_webhook_url_for_output);
    if json_output {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "status": "configured",
                "agentName": agent_name,
                "deliveryWebhookUrl": redacted_webhook_url,
                "deliveryHealthUrl": redacted_health_url,
                "deliveryWebhookHeaders": redacted_headers,
                "path": path,
            }))?
        );
    } else {
        println!("Connector delivery configured for `{agent_name}`.");
        println!("Delivery webhook: {redacted_webhook_url}");
        if let Some(health_url) = redacted_health_url.as_deref() {
            println!("Delivery health URL: {health_url}");
        }
        if !redacted_headers.is_empty() {
            println!("Delivery webhook headers:");
            for header in &redacted_headers {
                println!("  - {header}");
            }
        }
        println!("Saved: {}", path.display());
    }
    Ok(())
}

pub(super) async fn run_connector_doctor(
    options: &ConfigPathOptions,
    agent_name: &str,
    json_output: bool,
) -> Result<()> {
    let config = load_agent_delivery_config(options, agent_name)?.ok_or_else(|| {
        anyhow!(
            "connector delivery config not found for `{agent_name}`. Run `clawdentity connector configure {agent_name}` first."
        )
    })?;
    let reachable = clawdentity_core::check_delivery_webhook_health(
        &config.delivery_webhook_url,
        config.delivery_health_url.as_deref(),
    )
    .await
    .map_err(|error| anyhow!("delivery webhook health check failed: {error}"))?;
    let redacted_webhook_url = redact_webhook_url_for_output(&config.delivery_webhook_url);
    let redacted_health_url = config
        .delivery_health_url
        .as_deref()
        .map(redact_webhook_url_for_output);

    if json_output {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "agentName": agent_name,
                "deliveryWebhookUrl": redacted_webhook_url,
                "deliveryHealthUrl": redacted_health_url,
                "status": if reachable { "healthy" } else { "unhealthy" },
            }))?
        );
    } else {
        println!("Connector doctor for `{agent_name}`");
        println!("Delivery webhook: {redacted_webhook_url}");
        if let Some(health_url) = redacted_health_url.as_deref() {
            println!("Delivery health URL: {health_url}");
        }
        println!("Status: {}", if reachable { "healthy" } else { "unhealthy" });
    }
    Ok(())
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
    let now_ms = clawdentity_core::db::now_utc_ms();
    if let Some(runtime_inputs) = lookup_cached_runtime_inputs(options, agent_name, now_ms) {
        return Ok(runtime_inputs);
    }

    let blocking_options = options.clone();
    let blocking_agent_name = agent_name.to_string();
    let runtime_inputs = tokio::task::spawn_blocking(move || {
        resolve_runtime_inputs(&blocking_options, &blocking_agent_name)
    })
    .await
    .map_err(|error| anyhow!("failed to resolve connector runtime inputs: {error}"))??;
    remember_runtime_inputs(options, agent_name, &runtime_inputs, now_ms);
    Ok(runtime_inputs)
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

pub(crate) async fn fetch_registry_agent_profile(
    options: &ConfigPathOptions,
    agent_name: &str,
    agent_did: &str,
) -> Result<clawdentity_core::RegistryAgentProfile> {
    let normalized_agent_did = agent_did.trim();
    parse_agent_did(normalized_agent_did)
        .map_err(|error| anyhow!("agentDid is invalid: {error}"))?;
    let _ = load_runtime_inputs(options, agent_name).await?;
    fetch_registry_agent_profile_with_agent_auth(options, agent_name, normalized_agent_did)
        .await
        .map_err(anyhow::Error::from)
}

pub(crate) async fn fetch_group_name(
    options: &ConfigPathOptions,
    agent_name: &str,
    group_id: &str,
) -> Result<String> {
    let normalized_group_id =
        parse_group_id(group_id).map_err(|error| anyhow!("groupId is invalid: {error}"))?;
    let now_ms = clawdentity_core::db::now_utc_ms();
    if let Some(group_name) = lookup_cached_group_name(&normalized_group_id, now_ms) {
        return Ok(group_name);
    }

    let _ = load_runtime_inputs(options, agent_name).await?;
    match fetch_group_name_with_agent_auth(options, agent_name, &normalized_group_id).await {
        Ok(group_name) => {
            remember_group_name(&normalized_group_id, &group_name, now_ms);
            Ok(group_name)
        }
        Err(error) => {
            if let Some(group_name) = lookup_stale_cached_group_name(&normalized_group_id) {
                tracing::warn!(
                    error = %error,
                    group_id = %normalized_group_id,
                    "group lookup failed; reusing stale cached group name"
                );
                return Ok(group_name);
            }
            Err(error.into())
        }
    }
}
pub(super) async fn fetch_group_member_dids(
    options: &ConfigPathOptions,
    agent_name: &str,
    group_id: &str,
) -> Result<Vec<String>> {
    let normalized_group_id =
        parse_group_id(group_id).map_err(|error| anyhow!("groupId is invalid: {error}"))?;
    let _ = load_runtime_inputs(options, agent_name).await?;
    fetch_group_member_dids_with_agent_auth(options, agent_name, &normalized_group_id)
        .await
        .map_err(anyhow::Error::from)
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn temp_options() -> (tempfile::TempDir, ConfigPathOptions) {
        let temp_dir = tempdir().expect("temp dir");
        let options = ConfigPathOptions {
            home_dir: Some(temp_dir.path().to_path_buf()),
            registry_url_hint: None,
        };
        (temp_dir, options)
    }

    #[test]
    fn redacts_webhook_url_credentials_and_query_for_output() {
        let redacted = redact_webhook_url_for_output(
            "https://user:pass@example.com/hooks/message?token=secret#frag",
        );
        assert_eq!(redacted, "https://example.com/hooks/message");
    }

    #[test]
    fn parse_delivery_webhook_headers_rejects_reserved_header_name() {
        let result = parse_delivery_webhook_headers(&[
            "x-clawdentity-agent-did: did:cdi:test:agent:spoof".to_string(),
        ]);
        assert!(result.is_err());
    }

    #[test]
    fn save_delivery_config_rejects_invalid_webhook_url() {
        let (_temp_dir, options) = temp_options();
        let result = save_agent_delivery_config(
            &options,
            "alpha",
            &AgentDeliveryConfig {
                delivery_webhook_url: "ftp://example.com/hooks/message".to_string(),
                delivery_webhook_headers: vec![],
                delivery_health_url: None,
            },
            false,
        );
        assert!(result.is_err());
    }

    #[test]
    fn save_delivery_config_rejects_invalid_health_url() {
        let (_temp_dir, options) = temp_options();
        let result = save_agent_delivery_config(
            &options,
            "alpha",
            &AgentDeliveryConfig {
                delivery_webhook_url: "https://example.com/hooks/message".to_string(),
                delivery_webhook_headers: vec![],
                delivery_health_url: Some("ftp://example.com/health".to_string()),
            },
            false,
        );
        assert!(result.is_err());
    }
}
