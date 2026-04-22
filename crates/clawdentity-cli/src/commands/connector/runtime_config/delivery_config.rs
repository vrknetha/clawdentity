use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow};
use clawdentity_core::config::{ConfigPathOptions, get_config_dir};
use clawdentity_core::constants::AGENTS_DIR;
use serde::{Deserialize, Serialize};

const DELIVERY_CONFIG_FILE_NAME: &str = "delivery-webhook.json";
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentDeliveryConfig {
    pub(crate) delivery_webhook_url: String,
    #[serde(default)]
    pub(crate) delivery_webhook_headers: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) delivery_health_url: Option<String>,
}

pub(super) fn parse_delivery_webhook_headers(headers: &[String]) -> Result<Vec<(String, String)>> {
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
        parsed_headers.push(parse_delivery_webhook_header(candidate, name, value)?);
    }
    Ok(parsed_headers)
}

fn parse_delivery_webhook_header(
    candidate: &str,
    name: &str,
    value: &str,
) -> Result<(String, String)> {
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
    Ok((normalized_name, value.to_string()))
}

pub(super) fn normalize_and_validate_delivery_webhook_url(value: &str) -> Result<String> {
    let runtime = clawdentity_core::runtime_webhook::DeliveryWebhookRuntimeConfig {
        webhook_url: value.trim().to_string(),
        health_url: None,
        webhook_headers: Vec::new(),
    };
    runtime.validated_webhook_url().map_err(anyhow::Error::from)
}

pub(super) fn normalize_optional_delivery_health_url(
    value: Option<&str>,
) -> Result<Option<String>> {
    let Some(raw) = value
        .map(str::trim)
        .filter(|candidate| !candidate.is_empty())
    else {
        return Ok(None);
    };
    let parsed =
        reqwest::Url::parse(raw).map_err(|_| anyhow!("invalid delivery health URL: {raw}"))?;
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
        .map(|header| redact_delivery_header(header))
        .collect()
}

fn redact_delivery_header(header: &str) -> String {
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

fn delivery_config_path(config_dir: &Path, agent_name: &str) -> PathBuf {
    config_dir
        .join(AGENTS_DIR)
        .join(agent_name)
        .join(DELIVERY_CONFIG_FILE_NAME)
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
            .with_context(|| {
                format!(
                    "failed to write connector delivery config {}",
                    path.display()
                )
            })?;
        file.write_all(body.as_bytes()).with_context(|| {
            format!(
                "failed to write connector delivery config {}",
                path.display()
            )
        })?;
        file.write_all(b"\n").with_context(|| {
            format!(
                "failed to write connector delivery config {}",
                path.display()
            )
        })?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).with_context(|| {
            format!(
                "failed to secure connector delivery config {}",
                path.display()
            )
        })?;
        Ok(())
    }

    #[cfg(not(unix))]
    {
        fs::write(path, format!("{body}\n")).with_context(|| {
            format!(
                "failed to write connector delivery config {}",
                path.display()
            )
        })?;
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

pub(super) fn load_agent_delivery_config_from_dir(
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

pub(crate) fn save_agent_delivery_config(
    options: &ConfigPathOptions,
    agent_name: &str,
    config: &AgentDeliveryConfig,
    json_output: bool,
) -> Result<()> {
    let normalized_config = normalize_delivery_config(config)?;
    let path = delivery_config_path(&get_config_dir(options)?, agent_name);
    ensure_delivery_config_parent_dir(&path)?;
    let body = serde_json::to_string_pretty(&normalized_config)?;
    write_delivery_config_file(&path, &body)?;
    print_delivery_config_result(agent_name, &path, &normalized_config, json_output)
}

fn normalize_delivery_config(config: &AgentDeliveryConfig) -> Result<AgentDeliveryConfig> {
    parse_delivery_webhook_headers(&config.delivery_webhook_headers)?;
    Ok(AgentDeliveryConfig {
        delivery_webhook_url: normalize_and_validate_delivery_webhook_url(
            &config.delivery_webhook_url,
        )?,
        delivery_webhook_headers: config.delivery_webhook_headers.clone(),
        delivery_health_url: normalize_optional_delivery_health_url(
            config.delivery_health_url.as_deref(),
        )?,
    })
}

fn ensure_delivery_config_parent_dir(path: &Path) -> Result<()> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    fs::create_dir_all(parent).with_context(|| {
        format!(
            "failed to create connector delivery config directory {}",
            parent.display()
        )
    })
}

fn print_delivery_config_result(
    agent_name: &str,
    path: &Path,
    config: &AgentDeliveryConfig,
    json_output: bool,
) -> Result<()> {
    let output = redacted_delivery_config_output(config);
    if json_output {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "status": "configured",
                "agentName": agent_name,
                "deliveryWebhookUrl": output.webhook_url,
                "deliveryHealthUrl": output.health_url,
                "deliveryWebhookHeaders": output.headers,
                "path": path,
            }))?
        );
        return Ok(());
    }
    print_delivery_config_text(agent_name, path, &output);
    Ok(())
}

struct RedactedDeliveryConfigOutput {
    webhook_url: String,
    health_url: Option<String>,
    headers: Vec<String>,
}

fn redacted_delivery_config_output(config: &AgentDeliveryConfig) -> RedactedDeliveryConfigOutput {
    RedactedDeliveryConfigOutput {
        webhook_url: redact_webhook_url_for_output(&config.delivery_webhook_url),
        health_url: config
            .delivery_health_url
            .as_deref()
            .map(redact_webhook_url_for_output),
        headers: redact_delivery_webhook_headers(&config.delivery_webhook_headers),
    }
}

fn print_delivery_config_text(
    agent_name: &str,
    path: &Path,
    output: &RedactedDeliveryConfigOutput,
) {
    println!("Connector delivery configured for `{agent_name}`.");
    println!("Delivery webhook: {}", output.webhook_url);
    if let Some(health_url) = output.health_url.as_deref() {
        println!("Delivery health URL: {health_url}");
    }
    if !output.headers.is_empty() {
        println!("Delivery webhook headers:");
        for header in &output.headers {
            println!("  - {header}");
        }
    }
    println!("Saved: {}", path.display());
}

pub(crate) async fn run_connector_doctor(
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
    print_connector_doctor_result(agent_name, &config, reachable, json_output)
}

fn print_connector_doctor_result(
    agent_name: &str,
    config: &AgentDeliveryConfig,
    reachable: bool,
    json_output: bool,
) -> Result<()> {
    let output = redacted_delivery_config_output(config);
    if json_output {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "agentName": agent_name,
                "deliveryWebhookUrl": output.webhook_url,
                "deliveryHealthUrl": output.health_url,
                "status": if reachable { "healthy" } else { "unhealthy" },
            }))?
        );
        return Ok(());
    }
    print_connector_doctor_text(agent_name, &output, reachable);
    Ok(())
}

fn print_connector_doctor_text(
    agent_name: &str,
    output: &RedactedDeliveryConfigOutput,
    reachable: bool,
) {
    println!("Connector doctor for `{agent_name}`");
    println!("Delivery webhook: {}", output.webhook_url);
    if let Some(health_url) = output.health_url.as_deref() {
        println!("Delivery health URL: {health_url}");
    }
    println!(
        "Status: {}",
        if reachable { "healthy" } else { "unhealthy" }
    );
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
