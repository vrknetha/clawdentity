use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::config::{ConfigPathOptions, get_config_dir};
use crate::error::{CoreError, Result};
use crate::inspect_agent;

use super::{get_provider, read_text, write_json, write_text};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProviderRuntime {
    pub provider: String,
    pub agent_name: String,
    pub webhook_endpoint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub webhook_token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRelayRuntimeConfig {
    pub webhook_endpoint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connector_base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub webhook_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platform_base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relay_transform_peers_path: Option<String>,
    pub updated_at: String,
}

/// Loads the configured provider runtime for a non-OpenClaw agent.
///
/// OpenClaw uses its own runtime files and returns `Ok(None)`.
pub fn load_agent_provider_runtime(
    options: &ConfigPathOptions,
    agent_name: &str,
) -> Result<Option<AgentProviderRuntime>> {
    let inspect = inspect_agent(options, agent_name)?;
    let provider = inspect.framework.trim().to_ascii_lowercase();
    if provider.is_empty() || provider == "openclaw" {
        return Ok(None);
    }

    let provider_instance = get_provider(&provider).ok_or_else(|| {
        CoreError::InvalidInput(format!(
            "agent `{agent_name}` uses unsupported provider framework `{provider}`"
        ))
    })?;
    let config_dir = get_config_dir(options)?;

    let selected_agent = read_provider_agent_marker(&config_dir, provider_instance.name())?
        .ok_or_else(|| {
            CoreError::InvalidInput(format!(
                "provider runtime for `{}` is not configured for agent `{agent_name}`; run `clawdentity provider setup --for {}` first",
                provider_instance.display_name(),
                provider_instance.name()
            ))
        })?;
    if selected_agent != agent_name.trim() {
        return Err(CoreError::InvalidInput(format!(
            "provider runtime for `{}` is configured for agent `{selected_agent}`, not `{agent_name}`; rerun `clawdentity provider setup --for {}` for the intended agent",
            provider_instance.display_name(),
            provider_instance.name()
        )));
    }

    let runtime = load_provider_runtime_config(&config_dir, provider_instance.name())?
        .ok_or_else(|| {
            CoreError::InvalidInput(format!(
                "provider runtime details for `{}` are missing; run `clawdentity provider setup --for {}` first",
                provider_instance.display_name(),
                provider_instance.name()
            ))
        })?;

    Ok(Some(AgentProviderRuntime {
        provider,
        agent_name: selected_agent,
        webhook_endpoint: runtime.webhook_endpoint,
        webhook_token: runtime.webhook_token,
    }))
}

/// Returns the current UTC timestamp in RFC 3339 format.
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Resolves the provider state directory under the selected home directory.
pub fn resolve_state_dir(home_dir: Option<PathBuf>) -> Result<PathBuf> {
    let options = ConfigPathOptions {
        home_dir,
        registry_url_hint: None,
    };
    get_config_dir(&options)
}

fn provider_agent_marker_path(state_dir: &Path, provider: &str) -> PathBuf {
    state_dir.join(format!("{provider}-agent-name"))
}

fn provider_runtime_path(state_dir: &Path, provider: &str) -> PathBuf {
    state_dir.join(format!("{provider}-relay.json"))
}

/// Persists the selected agent marker for a provider-backed runtime.
pub fn write_provider_agent_marker(
    state_dir: &Path,
    provider: &str,
    agent_name: &str,
) -> Result<PathBuf> {
    let agent_name = agent_name.trim();
    if agent_name.is_empty() {
        return Err(CoreError::InvalidInput(
            "agent name cannot be empty".to_string(),
        ));
    }
    let path = provider_agent_marker_path(state_dir, provider);
    write_text(&path, &format!("{agent_name}\n"))?;
    Ok(path)
}

/// Reads the selected agent marker for a provider-backed runtime.
pub fn read_provider_agent_marker(state_dir: &Path, provider: &str) -> Result<Option<String>> {
    let path = provider_agent_marker_path(state_dir, provider);
    let value = read_text(&path)?;
    Ok(value.and_then(|value| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    }))
}

/// Persists the provider runtime details used by live connector delivery.
pub fn save_provider_runtime_config(
    state_dir: &Path,
    provider: &str,
    config: ProviderRelayRuntimeConfig,
) -> Result<PathBuf> {
    let path = provider_runtime_path(state_dir, provider);
    let mut value = serde_json::to_value(&config)?;
    if !value.is_object() {
        value = Value::Object(Map::new());
    }
    write_json(&path, &value)?;
    Ok(path)
}

/// Loads the provider runtime details used by live connector delivery.
pub fn load_provider_runtime_config(
    state_dir: &Path,
    provider: &str,
) -> Result<Option<ProviderRelayRuntimeConfig>> {
    let path = provider_runtime_path(state_dir, provider);
    let value = match read_text(&path)? {
        Some(raw) => {
            if raw.trim().is_empty() {
                return Ok(None);
            }
            serde_json::from_str::<ProviderRelayRuntimeConfig>(&raw).map_err(|source| {
                CoreError::JsonParse {
                    path: path.clone(),
                    source,
                }
            })?
        }
        None => return Ok(None),
    };
    Ok(Some(value))
}
