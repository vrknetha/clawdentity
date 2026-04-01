use std::collections::HashMap;
use std::path::Path;

use serde_yaml::{Mapping, Number as YamlNumber, Value as YamlValue};
use sha2::{Digest, Sha256};

use crate::error::{CoreError, Result};
use crate::provider::{
    InstallOptions, PlatformProvider, ProviderRelayRuntimeConfig, ProviderSetupOptions,
    default_webhook_url, join_url_path, now_iso, read_text, write_text,
};

use super::{
    HERMES_DEFAULT_PROMPT, HERMES_ROUTE_NAME, HERMES_SECRET_BYTES, HERMES_WEBHOOK_PATH,
    HermesInstallArtifacts, HermesProvider,
};

impl HermesProvider {
    pub(super) fn load_yaml_or_default(path: &Path) -> Result<YamlValue> {
        let Some(raw) = read_text(path)? else {
            return Ok(YamlValue::Mapping(Mapping::new()));
        };
        if raw.trim().is_empty() {
            return Ok(YamlValue::Mapping(Mapping::new()));
        }
        serde_yaml::from_str::<YamlValue>(&raw).map_err(|error| {
            CoreError::InvalidInput(format!(
                "failed to parse YAML at {}: {error}",
                path.display()
            ))
        })
    }

    fn write_yaml(path: &Path, value: &YamlValue) -> Result<()> {
        let body = serde_yaml::to_string(value).map_err(|error| {
            CoreError::InvalidInput(format!(
                "failed to serialize YAML for {}: {error}",
                path.display()
            ))
        })?;
        write_text(path, &body)
    }

    fn yaml_key(key: &str) -> YamlValue {
        YamlValue::String(key.to_string())
    }

    fn ensure_mapping(value: &mut YamlValue) -> &mut Mapping {
        if !value.is_mapping() {
            *value = YamlValue::Mapping(Mapping::new());
        }
        value
            .as_mapping_mut()
            .expect("mapping conversion must succeed")
    }

    fn ensure_mapping_entry<'a>(map: &'a mut Mapping, key: &str) -> &'a mut Mapping {
        let entry = map
            .entry(Self::yaml_key(key))
            .or_insert_with(|| YamlValue::Mapping(Mapping::new()));
        Self::ensure_mapping(entry)
    }

    fn mapping_string(map: &Mapping, key: &str) -> Option<String> {
        map.get(Self::yaml_key(key))
            .and_then(YamlValue::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    }

    fn mapping_u16(map: &Mapping, key: &str) -> Option<u16> {
        map.get(Self::yaml_key(key)).and_then(|value| {
            value
                .as_u64()
                .and_then(|number| u16::try_from(number).ok())
                .or_else(|| value.as_i64().and_then(|number| u16::try_from(number).ok()))
        })
    }

    fn route_config<'a>(config: &'a YamlValue, route_name: &str) -> Option<&'a Mapping> {
        config
            .as_mapping()
            .and_then(|root| root.get(Self::yaml_key("platforms")))
            .and_then(YamlValue::as_mapping)
            .and_then(|platforms| platforms.get(Self::yaml_key("webhook")))
            .and_then(YamlValue::as_mapping)
            .and_then(|webhook| webhook.get(Self::yaml_key("extra")))
            .and_then(YamlValue::as_mapping)
            .and_then(|extra| extra.get(Self::yaml_key("routes")))
            .and_then(YamlValue::as_mapping)
            .and_then(|routes| routes.get(Self::yaml_key(route_name)))
            .and_then(YamlValue::as_mapping)
    }

    pub(super) fn route_secret(config: &YamlValue, route_name: &str) -> Option<String> {
        Self::route_config(config, route_name)
            .and_then(|route| Self::mapping_string(route, "secret"))
    }

    pub(super) fn configured_webhook_host(config: &YamlValue) -> Option<String> {
        config
            .as_mapping()
            .and_then(|root| root.get(Self::yaml_key("platforms")))
            .and_then(YamlValue::as_mapping)
            .and_then(|platforms| platforms.get(Self::yaml_key("webhook")))
            .and_then(YamlValue::as_mapping)
            .and_then(|webhook| webhook.get(Self::yaml_key("extra")))
            .and_then(YamlValue::as_mapping)
            .and_then(|extra| Self::mapping_string(extra, "host"))
    }

    pub(super) fn configured_webhook_port(config: &YamlValue) -> Option<u16> {
        config
            .as_mapping()
            .and_then(|root| root.get(Self::yaml_key("platforms")))
            .and_then(YamlValue::as_mapping)
            .and_then(|platforms| platforms.get(Self::yaml_key("webhook")))
            .and_then(YamlValue::as_mapping)
            .and_then(|webhook| webhook.get(Self::yaml_key("extra")))
            .and_then(YamlValue::as_mapping)
            .and_then(|extra| Self::mapping_u16(extra, "port"))
    }

    fn generate_webhook_secret() -> Result<String> {
        let mut bytes = [0_u8; HERMES_SECRET_BYTES];
        getrandom::fill(&mut bytes).map_err(|error| {
            CoreError::InvalidInput(format!("failed to generate webhook secret: {error}"))
        })?;
        Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
    }

    fn upsert_clawdentity_route(config: &mut YamlValue, opts: &InstallOptions, secret: &str) {
        let root = Self::ensure_mapping(config);
        let platforms = Self::ensure_mapping_entry(root, "platforms");
        let webhook = Self::ensure_mapping_entry(platforms, "webhook");
        webhook.insert(Self::yaml_key("enabled"), YamlValue::Bool(true));

        let extra = Self::ensure_mapping_entry(webhook, "extra");
        if let Some(host) = opts
            .webhook_host
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            extra.insert(Self::yaml_key("host"), YamlValue::String(host.to_string()));
        }
        let port = opts.webhook_port.unwrap_or(8644);
        extra.insert(
            Self::yaml_key("port"),
            YamlValue::Number(YamlNumber::from(u64::from(port))),
        );

        let routes = Self::ensure_mapping_entry(extra, "routes");
        let route = Self::ensure_mapping_entry(routes, HERMES_ROUTE_NAME);
        route.insert(
            Self::yaml_key("secret"),
            YamlValue::String(secret.to_string()),
        );
        route.insert(
            Self::yaml_key("events"),
            YamlValue::Sequence(vec![YamlValue::String("*".to_string())]),
        );
        route.insert(
            Self::yaml_key("prompt"),
            YamlValue::String(HERMES_DEFAULT_PROMPT.to_string()),
        );
    }

    pub(super) fn resolve_webhook_url(
        &self,
        opts: &InstallOptions,
        config: &YamlValue,
    ) -> Result<String> {
        if let Some(connector_url) = opts
            .connector_url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return join_url_path(connector_url, HERMES_WEBHOOK_PATH, "connectorUrl");
        }

        let host = opts
            .webhook_host
            .clone()
            .or_else(|| Self::configured_webhook_host(config))
            .unwrap_or_else(|| self.default_webhook_host().to_string());
        let port = opts
            .webhook_port
            .or_else(|| Self::configured_webhook_port(config))
            .unwrap_or(self.default_webhook_port());
        default_webhook_url(&host, port, HERMES_WEBHOOK_PATH)
    }

    pub(super) fn configure_install(
        &self,
        opts: &InstallOptions,
    ) -> Result<HermesInstallArtifacts> {
        let home_dir = self.install_home_dir(opts)?;
        let config_path = Self::config_path_from_home(&home_dir);
        let mut config = Self::load_yaml_or_default(&config_path)?;
        let explicit_secret = opts
            .webhook_token
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);
        let existing_secret = Self::route_secret(&config, HERMES_ROUTE_NAME);

        let (webhook_secret, generated_secret) = if let Some(secret) = explicit_secret {
            (secret, false)
        } else if let Some(secret) = existing_secret {
            (secret, false)
        } else {
            (Self::generate_webhook_secret()?, true)
        };

        Self::upsert_clawdentity_route(&mut config, opts, &webhook_secret);
        Self::write_yaml(&config_path, &config)?;
        let webhook_endpoint = self.resolve_webhook_url(opts, &config)?;

        Ok(HermesInstallArtifacts {
            config_path,
            webhook_endpoint,
            webhook_secret,
            generated_secret,
        })
    }

    pub(super) fn hmac_sha256_hex(secret: &str, payload: &[u8]) -> String {
        const BLOCK_SIZE: usize = 64;
        let mut key = secret.as_bytes().to_vec();
        if key.len() > BLOCK_SIZE {
            key = Sha256::digest(&key).to_vec();
        }
        if key.len() < BLOCK_SIZE {
            key.resize(BLOCK_SIZE, 0);
        }

        let mut ipad = vec![0x36; BLOCK_SIZE];
        let mut opad = vec![0x5c; BLOCK_SIZE];
        for (index, value) in key.iter().enumerate() {
            ipad[index] ^= value;
            opad[index] ^= value;
        }

        let mut inner = Sha256::new();
        inner.update(&ipad);
        inner.update(payload);
        let inner_hash = inner.finalize();

        let mut outer = Sha256::new();
        outer.update(&opad);
        outer.update(inner_hash);
        let digest = outer.finalize();
        digest.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    pub(super) fn build_session_key(sender_id: &str, metadata: &HashMap<String, String>) -> String {
        let base = metadata
            .get("groupId")
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|group_id| format!("group:{group_id}"))
            .unwrap_or_else(|| format!("peer:{}", sender_id.trim()));

        if let Some(conversation_id) = metadata
            .get("conversationId")
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            format!("{base}:{conversation_id}")
        } else {
            base
        }
    }

    pub(super) fn setup_install_options(opts: &ProviderSetupOptions) -> InstallOptions {
        InstallOptions {
            home_dir: opts.home_dir.clone(),
            webhook_port: opts.webhook_port,
            webhook_host: opts.webhook_host.clone(),
            webhook_token: opts.webhook_token.clone(),
            connector_url: opts
                .connector_url
                .clone()
                .or_else(|| opts.connector_base_url.clone()),
        }
    }

    pub(super) fn resolve_agent_name(opts: &ProviderSetupOptions) -> String {
        opts.agent_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("default")
            .to_string()
    }

    pub(super) fn build_runtime_config(
        opts: &ProviderSetupOptions,
        artifacts: &HermesInstallArtifacts,
    ) -> ProviderRelayRuntimeConfig {
        ProviderRelayRuntimeConfig {
            webhook_endpoint: artifacts.webhook_endpoint.clone(),
            connector_base_url: opts.connector_base_url.clone(),
            webhook_token: Some(artifacts.webhook_secret.clone()),
            platform_base_url: opts.platform_base_url.clone(),
            relay_transform_peers_path: opts.relay_transform_peers_path.clone(),
            updated_at: now_iso(),
        }
    }

    pub(super) fn setup_notes(artifacts: &HermesInstallArtifacts, agent_name: &str) -> Vec<String> {
        let mut notes = vec![format!("updated {}", artifacts.config_path.display())];
        if artifacts.generated_secret {
            notes.push("generated and saved webhook secret".to_string());
        }
        notes.push(format!("saved selected agent marker `{agent_name}`"));
        notes.push("saved provider relay runtime".to_string());
        notes
    }

    pub(super) fn route_exists(config: &YamlValue, route_name: &str) -> bool {
        Self::route_config(config, route_name).is_some()
    }
}
