use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, Result};

pub const DEFAULT_REGISTRY_URL: &str = "https://registry.clagram.com";
const DEFAULT_DEV_REGISTRY_URL: &str = "https://dev.registry.clagram.com";
const DEFAULT_LOCAL_REGISTRY_URL: &str = "http://127.0.0.1:8788";

const CONFIG_ROOT_DIR: &str = ".clagram";
const CONFIG_STATES_DIR: &str = "states";
const CONFIG_ROUTER_FILE: &str = "router.json";
const CONFIG_FILE: &str = "config.json";
const FILE_MODE: u32 = 0o600;

const PROD_REGISTRY_HOST: &str = "registry.clagram.com";
const DEV_REGISTRY_HOST: &str = "dev.registry.clagram.com";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliStateKind {
    Prod,
    Dev,
    Local,
}

impl CliStateKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Prod => "prod",
            Self::Dev => "dev",
            Self::Local => "local",
        }
    }

    fn from_str(value: &str) -> Option<Self> {
        match value {
            "prod" => Some(Self::Prod),
            "dev" => Some(Self::Dev),
            "local" => Some(Self::Local),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ConfigPathOptions {
    pub home_dir: Option<PathBuf>,
    pub registry_url_hint: Option<String>,
}

impl ConfigPathOptions {
    pub fn with_registry_hint(&self, registry_url_hint: impl Into<String>) -> Self {
        let mut next = self.clone();
        next.registry_url_hint = Some(registry_url_hint.into());
        next
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliConfig {
    pub registry_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub human_name: Option<String>,
}

impl Default for CliConfig {
    fn default() -> Self {
        Self {
            registry_url: DEFAULT_REGISTRY_URL.to_string(),
            proxy_url: None,
            api_key: None,
            human_name: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigKey {
    RegistryUrl,
    ProxyUrl,
    ApiKey,
    HumanName,
}

impl ConfigKey {
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "registryUrl" => Ok(Self::RegistryUrl),
            "proxyUrl" => Ok(Self::ProxyUrl),
            "apiKey" => Ok(Self::ApiKey),
            "humanName" => Ok(Self::HumanName),
            other => Err(CoreError::InvalidConfigKey(other.to_string())),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::RegistryUrl => "registryUrl",
            Self::ProxyUrl => "proxyUrl",
            Self::ApiKey => "apiKey",
            Self::HumanName => "humanName",
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliStateRouter {
    #[serde(skip_serializing_if = "Option::is_none")]
    last_registry_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_state: Option<String>,
}

fn trim_non_empty(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn env_first_non_empty(keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        std::env::var(key).ok().and_then(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        })
    })
}

fn env_registry_override() -> Option<String> {
    env_first_non_empty(&[
        "CLAGRAM_REGISTRY_URL",
        "CLAWDENTITY_REGISTRY_URL",
        "CLAWDENTITY_REGISTRY",
    ])
}

fn env_proxy_override() -> Option<String> {
    env_first_non_empty(&["CLAGRAM_PROXY_URL", "CLAWDENTITY_PROXY_URL"])
}

fn env_api_key_override() -> Option<String> {
    env_first_non_empty(&["CLAGRAM_API_KEY", "CLAWDENTITY_API_KEY"])
}

fn env_human_name_override() -> Option<String> {
    env_first_non_empty(&["CLAGRAM_HUMAN_NAME", "CLAWDENTITY_HUMAN_NAME"])
}

pub fn resolve_state_kind_from_registry_url(registry_url: &str) -> CliStateKind {
    let parsed = match url::Url::parse(registry_url) {
        Ok(parsed) => parsed,
        Err(_) => return CliStateKind::Prod,
    };

    let host = match parsed.host_str() {
        Some(host) => host.to_ascii_lowercase(),
        None => return CliStateKind::Prod,
    };

    if host == DEV_REGISTRY_HOST {
        return CliStateKind::Dev;
    }

    if host == PROD_REGISTRY_HOST {
        return CliStateKind::Prod;
    }

    if host == "localhost" || host == "127.0.0.1" || host == "host.docker.internal" {
        return CliStateKind::Local;
    }

    CliStateKind::Prod
}

fn default_registry_url_for_state(state_kind: CliStateKind) -> &'static str {
    match state_kind {
        CliStateKind::Prod => DEFAULT_REGISTRY_URL,
        CliStateKind::Dev => DEFAULT_DEV_REGISTRY_URL,
        CliStateKind::Local => DEFAULT_LOCAL_REGISTRY_URL,
    }
}

fn resolve_home_dir(home_override: Option<&Path>) -> Result<PathBuf> {
    if let Some(home) = home_override {
        return Ok(home.to_path_buf());
    }
    dirs::home_dir().ok_or(CoreError::HomeDirectoryUnavailable)
}

pub fn get_config_root_dir(options: &ConfigPathOptions) -> Result<PathBuf> {
    Ok(resolve_home_dir(options.home_dir.as_deref())?.join(CONFIG_ROOT_DIR))
}

fn get_states_dir(options: &ConfigPathOptions) -> Result<PathBuf> {
    Ok(get_config_root_dir(options)?.join(CONFIG_STATES_DIR))
}

fn get_router_path(options: &ConfigPathOptions) -> Result<PathBuf> {
    Ok(get_config_root_dir(options)?.join(CONFIG_ROUTER_FILE))
}

fn read_router(options: &ConfigPathOptions) -> Result<CliStateRouter> {
    let path = get_router_path(options)?;
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(CliStateRouter::default());
        }
        Err(source) => {
            return Err(CoreError::Io {
                path: path.clone(),
                source,
            });
        }
    };

    serde_json::from_str::<CliStateRouter>(&raw)
        .map_err(|source| CoreError::JsonParse { path, source })
}

fn write_router(options: &ConfigPathOptions, router: &CliStateRouter) -> Result<()> {
    let path = get_router_path(options)?;
    write_secure_json(&path, router)
}

fn resolve_state_selection(
    options: &ConfigPathOptions,
    router: &CliStateRouter,
) -> (CliStateKind, String) {
    if let Some(hint) = trim_non_empty(options.registry_url_hint.clone()) {
        let state = resolve_state_kind_from_registry_url(&hint);
        return (state, hint);
    }

    if let Some(from_env) = env_registry_override() {
        let state = resolve_state_kind_from_registry_url(&from_env);
        return (state, from_env);
    }

    if let Some(last_registry_url) = trim_non_empty(router.last_registry_url.clone()) {
        let state = resolve_state_kind_from_registry_url(&last_registry_url);
        return (state, last_registry_url);
    }

    let state = router
        .last_state
        .as_deref()
        .and_then(CliStateKind::from_str)
        .unwrap_or(CliStateKind::Prod);

    (state, default_registry_url_for_state(state).to_string())
}

pub fn get_config_dir(options: &ConfigPathOptions) -> Result<PathBuf> {
    let router = read_router(options)?;
    let (state, _) = resolve_state_selection(options, &router);
    Ok(get_states_dir(options)?.join(state.as_str()))
}

pub fn get_config_file_path(options: &ConfigPathOptions) -> Result<PathBuf> {
    Ok(get_config_dir(options)?.join(CONFIG_FILE))
}

fn normalize_config(config: CliConfig) -> CliConfig {
    let registry_url = if config.registry_url.trim().is_empty() {
        DEFAULT_REGISTRY_URL.to_string()
    } else {
        config.registry_url
    };

    CliConfig {
        registry_url,
        proxy_url: trim_non_empty(config.proxy_url),
        api_key: trim_non_empty(config.api_key),
        human_name: trim_non_empty(config.human_name),
    }
}

fn load_config_file(path: &Path) -> Result<CliConfig> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(CliConfig::default());
        }
        Err(source) => {
            return Err(CoreError::Io {
                path: path.to_path_buf(),
                source,
            });
        }
    };

    if raw.trim().is_empty() {
        return Ok(CliConfig::default());
    }

    serde_json::from_str::<CliConfig>(&raw)
        .map(normalize_config)
        .map_err(|source| CoreError::JsonParse {
            path: path.to_path_buf(),
            source,
        })
}

pub fn read_config(options: &ConfigPathOptions) -> Result<CliConfig> {
    let path = get_config_file_path(options)?;
    load_config_file(&path)
}

pub fn resolve_config(options: &ConfigPathOptions) -> Result<CliConfig> {
    let mut config = read_config(options)?;
    if let Some(registry_url) = env_registry_override() {
        config.registry_url = registry_url;
    }
    if let Some(proxy_url) = env_proxy_override() {
        config.proxy_url = Some(proxy_url);
    }
    if let Some(api_key) = env_api_key_override() {
        config.api_key = Some(api_key);
    }
    if let Some(human_name) = env_human_name_override() {
        config.human_name = Some(human_name);
    }

    Ok(normalize_config(config))
}

fn write_secure_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|source| CoreError::Io {
            path: parent.to_path_buf(),
            source,
        })?;
    }

    let body = serde_json::to_string_pretty(value)?;
    let content = format!("{body}\n");
    let tmp_path = path.with_extension("tmp");
    fs::write(&tmp_path, content).map_err(|source| CoreError::Io {
        path: tmp_path.clone(),
        source,
    })?;
    set_secure_permissions(&tmp_path)?;

    fs::rename(&tmp_path, path).map_err(|source| CoreError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    set_secure_permissions(path)?;

    Ok(())
}

#[cfg(unix)]
fn set_secure_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let permissions = fs::Permissions::from_mode(FILE_MODE);
    fs::set_permissions(path, permissions).map_err(|source| CoreError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    Ok(())
}

#[cfg(not(unix))]
fn set_secure_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

pub fn write_config(config: &CliConfig, options: &ConfigPathOptions) -> Result<PathBuf> {
    let normalized = normalize_config(config.clone());
    let state = resolve_state_kind_from_registry_url(&normalized.registry_url);
    let target_dir = get_states_dir(options)?.join(state.as_str());
    let target_path = target_dir.join(CONFIG_FILE);
    write_secure_json(&target_path, &normalized)?;

    let router = CliStateRouter {
        last_registry_url: Some(normalized.registry_url),
        last_state: Some(state.as_str().to_string()),
    };
    write_router(options, &router)?;

    Ok(target_path)
}

pub fn set_config_value(
    key: ConfigKey,
    value: String,
    options: &ConfigPathOptions,
) -> Result<CliConfig> {
    let mut config = read_config(options)?;
    let trimmed = value.trim().to_string();

    match key {
        ConfigKey::RegistryUrl => {
            config.registry_url = if trimmed.is_empty() {
                DEFAULT_REGISTRY_URL.to_string()
            } else {
                trimmed
            };
        }
        ConfigKey::ProxyUrl => {
            config.proxy_url = if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            };
        }
        ConfigKey::ApiKey => {
            config.api_key = if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            };
        }
        ConfigKey::HumanName => {
            config.human_name = if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            };
        }
    }

    let normalized = normalize_config(config);
    let _ = write_config(&normalized, options)?;
    Ok(normalized)
}

pub fn get_config_value(key: ConfigKey, options: &ConfigPathOptions) -> Result<Option<String>> {
    let config = resolve_config(options)?;
    Ok(match key {
        ConfigKey::RegistryUrl => Some(config.registry_url),
        ConfigKey::ProxyUrl => config.proxy_url,
        ConfigKey::ApiKey => config.api_key,
        ConfigKey::HumanName => config.human_name,
    })
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::*;

    fn opts(home: &Path) -> ConfigPathOptions {
        ConfigPathOptions {
            home_dir: Some(home.to_path_buf()),
            registry_url_hint: None,
        }
    }

    #[test]
    fn state_kind_is_derived_from_registry_host() {
        assert_eq!(
            resolve_state_kind_from_registry_url("https://registry.clagram.com"),
            CliStateKind::Prod
        );
        assert_eq!(
            resolve_state_kind_from_registry_url("https://dev.registry.clagram.com"),
            CliStateKind::Dev
        );
        assert_eq!(
            resolve_state_kind_from_registry_url("http://127.0.0.1:8788"),
            CliStateKind::Local
        );
    }

    #[test]
    fn write_config_routes_to_state_directory() {
        let tmp = TempDir::new().expect("temp dir");
        let options = opts(tmp.path());

        let dev = CliConfig {
            registry_url: "https://dev.registry.clagram.com".to_string(),
            proxy_url: Some("https://proxy.dev.clagram.com".to_string()),
            api_key: None,
            human_name: None,
        };
        let dev_path = write_config(&dev, &options).expect("write dev");
        assert!(dev_path.ends_with(".clagram/states/dev/config.json"));

        let prod = CliConfig {
            registry_url: "https://registry.clagram.com".to_string(),
            proxy_url: None,
            api_key: None,
            human_name: None,
        };
        let prod_path = write_config(&prod, &options).expect("write prod");
        assert!(prod_path.ends_with(".clagram/states/prod/config.json"));
    }

    #[test]
    fn set_and_get_config_value_round_trips() {
        let tmp = TempDir::new().expect("temp dir");
        let options = opts(tmp.path());

        let written = set_config_value(ConfigKey::HumanName, "Alice".to_string(), &options)
            .expect("set config");
        assert_eq!(written.human_name.as_deref(), Some("Alice"));

        let read_back = get_config_value(ConfigKey::HumanName, &options).expect("get value");
        assert_eq!(read_back.as_deref(), Some("Alice"));
    }

    #[test]
    fn read_config_returns_default_when_missing() {
        let tmp = TempDir::new().expect("temp dir");
        let options = opts(tmp.path());
        let config = read_config(&options).expect("read config");
        assert_eq!(config.registry_url, DEFAULT_REGISTRY_URL);
        assert!(config.proxy_url.is_none());
    }
}
