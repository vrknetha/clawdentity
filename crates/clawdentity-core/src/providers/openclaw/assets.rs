use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

#[path = "asset_bundle.rs"]
mod asset_bundle;

use self::asset_bundle::{OpenclawAsset, openclaw_assets};
pub use self::asset_bundle::{
    RELAY_MODULE_FILE_NAME, RELAY_PEERS_FILE_NAME, RELAY_RUNTIME_FILE_NAME, SKILL_DIR_NAME,
};
use super::cli::run_openclaw_config_set_json;
use crate::error::{CoreError, Result};
use crate::peers::PeersConfig;

const HOOK_MAPPING_ID: &str = "clawdentity-send-to-peer";
const HOOK_PATH_SEND_TO_PEER: &str = "send-to-peer";
const DEFAULT_OPENCLAW_MAIN_SESSION_KEY: &str = "main";
const HOOK_TOKEN_BYTES: usize = 32;
const FILE_MODE: u32 = 0o600;
const CONNECTOR_HOST_LOOPBACK: &str = "127.0.0.1";
const CONNECTOR_HOST_LOCALHOST: &str = "localhost";
const CONNECTOR_HOST_DOCKER: &str = "host.docker.internal";
const CONNECTOR_HOST_DOCKER_GATEWAY: &str = "gateway.docker.internal";
const CONNECTOR_HOST_LINUX_BRIDGE: &str = "172.17.0.1";
const DEFAULT_CONNECTOR_OUTBOUND_PATH: &str = "/v1/outbound";

pub struct OpenclawConfigPatchResult {
    pub config_changed: bool,
}

fn write_secure_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|source| CoreError::Io {
            path: parent.to_path_buf(),
            source,
        })?;
    }
    fs::write(path, bytes).map_err(|source| CoreError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(FILE_MODE)).map_err(|source| {
            CoreError::Io {
                path: path.to_path_buf(),
                source,
            }
        })?;
    }
    Ok(())
}

fn write_if_changed(path: &Path, bytes: &[u8]) -> Result<bool> {
    match fs::read(path) {
        Ok(existing) if existing == bytes => Ok(false),
        Ok(_) | Err(_) => {
            write_secure_bytes(path, bytes)?;
            Ok(true)
        }
    }
}

fn parse_json_or_default(path: &Path) -> Result<Value> {
    match fs::read_to_string(path) {
        Ok(raw) => json5::from_str::<Value>(&raw).map_err(|source| CoreError::Json5Parse {
            path: path.to_path_buf(),
            message: source.to_string(),
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(source) => Err(CoreError::Io {
            path: path.to_path_buf(),
            source,
        }),
    }
}

fn ensure_object(value: &mut Value) -> Result<&mut Map<String, Value>> {
    if !value.is_object() {
        *value = json!({});
    }
    value.as_object_mut().ok_or_else(|| {
        CoreError::InvalidInput("OpenClaw config root must be an object".to_string())
    })
}

fn ensure_object_key<'a>(
    parent: &'a mut Map<String, Value>,
    key: &str,
) -> Result<&'a mut Map<String, Value>> {
    let entry = parent.entry(key.to_string()).or_insert_with(|| json!({}));
    if !entry.is_object() {
        *entry = json!({});
    }
    entry.as_object_mut().ok_or_else(|| {
        CoreError::InvalidInput(format!("OpenClaw config `{key}` must be an object"))
    })
}

fn normalize_string_array_with_values(current: Option<&Value>, extra: &[&str]) -> Vec<Value> {
    let mut values = current
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();

    for extra_value in extra {
        let trimmed = extra_value.trim();
        if trimmed.is_empty() {
            continue;
        }
        if !values.iter().any(|value| value == trimmed) {
            values.push(trimmed.to_string());
        }
    }

    values.into_iter().map(Value::String).collect()
}

fn parse_gateway_auth_mode(value: Option<&str>) -> Option<&'static str> {
    let normalized = value?.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "token" => Some("token"),
        "password" => Some("password"),
        "trusted-proxy" => Some("trusted-proxy"),
        "none" => Some("none"),
        _ => None,
    }
}

fn generate_token_hex(bytes_len: usize) -> String {
    let mut bytes = vec![0_u8; bytes_len];
    getrandom::fill(&mut bytes).expect("token generation should not fail");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn note_install_result(asset: &OpenclawAsset) -> Result<String> {
    let changed = write_if_changed(&asset.path, &asset.bytes)?;
    Ok(format!(
        "{} {}",
        if changed {
            asset.install_note
        } else {
            "verified"
        },
        asset.path.display()
    ))
}

fn non_empty_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn resolve_hook_token(hooks: &Map<String, Value>, preferred_hook_token: Option<&str>) -> String {
    non_empty_string(hooks.get("token"))
        .or_else(|| preferred_hook_token.map(str::trim).map(ToOwned::to_owned))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| generate_token_hex(HOOK_TOKEN_BYTES))
}

fn resolve_default_session_key(hooks: &Map<String, Value>) -> String {
    non_empty_string(hooks.get("defaultSessionKey"))
        .unwrap_or_else(|| DEFAULT_OPENCLAW_MAIN_SESSION_KEY.to_string())
}

fn relay_mapping_matches(mapping: &Value) -> bool {
    mapping
        .get("id")
        .and_then(Value::as_str)
        .map(|value| value == HOOK_MAPPING_ID)
        .unwrap_or(false)
        || mapping
            .get("match")
            .and_then(Value::as_object)
            .and_then(|value| value.get("path"))
            .and_then(Value::as_str)
            .map(|value| value == HOOK_PATH_SEND_TO_PEER)
            .unwrap_or(false)
}

fn relay_mapping_definition() -> Value {
    json!({
        "id": HOOK_MAPPING_ID,
        "match": { "path": HOOK_PATH_SEND_TO_PEER },
        "action": "wake",
        "wakeMode": "now",
        "transform": { "module": RELAY_MODULE_FILE_NAME },
    })
}

fn relay_mappings_with_upsert(mut mappings: Vec<Value>) -> Vec<Value> {
    let relay_mapping = relay_mapping_definition();
    if let Some(index) = mappings.iter().position(relay_mapping_matches) {
        mappings[index] = relay_mapping;
    } else {
        mappings.push(relay_mapping);
    }
    mappings
}

fn target_allowed_session_key_prefixes(
    hooks: &Map<String, Value>,
    default_session_key: &str,
) -> Vec<Value> {
    normalize_string_array_with_values(
        hooks.get("allowedSessionKeyPrefixes"),
        &["hook:", default_session_key],
    )
}

fn read_existing_mappings(hooks: &Map<String, Value>) -> Vec<Value> {
    hooks
        .get("mappings")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn hook_settings_match(
    hooks: &Map<String, Value>,
    resolved_hook_token: &str,
    default_session_key: &str,
) -> bool {
    hooks.get("enabled").and_then(Value::as_bool) == Some(true)
        && hooks.get("token").and_then(Value::as_str) == Some(resolved_hook_token)
        && hooks.get("defaultSessionKey").and_then(Value::as_str) == Some(default_session_key)
        && hooks.get("allowRequestSessionKey").and_then(Value::as_bool) == Some(false)
        && hooks
            .get("allowedSessionKeyPrefixes")
            .and_then(Value::as_array)
            .cloned()
            == Some(target_allowed_session_key_prefixes(
                hooks,
                default_session_key,
            ))
        && read_existing_mappings(hooks)
            == relay_mappings_with_upsert(read_existing_mappings(hooks))
}

fn hook_session_routing_ready(hooks: Option<&Map<String, Value>>) -> bool {
    let Some(hooks) = hooks else {
        return false;
    };
    let default_session_key = resolve_default_session_key(hooks);
    hooks
        .get("defaultSessionKey")
        .and_then(Value::as_str)
        .map(str::trim)
        == Some(default_session_key.as_str())
        && hooks.get("allowRequestSessionKey").and_then(Value::as_bool) == Some(false)
        && hooks
            .get("allowedSessionKeyPrefixes")
            .and_then(Value::as_array)
            .cloned()
            == Some(target_allowed_session_key_prefixes(
                hooks,
                &default_session_key,
            ))
}

fn read_hooks(config: &Value) -> Option<&Map<String, Value>> {
    config.get("hooks").and_then(Value::as_object)
}

fn hook_mapping_present(hooks: Option<&Map<String, Value>>) -> bool {
    hooks
        .and_then(|value| value.get("mappings"))
        .and_then(Value::as_array)
        .map(|mappings| {
            mappings.iter().any(|mapping| {
                mapping
                    .get("match")
                    .and_then(Value::as_object)
                    .and_then(|value| value.get("path"))
                    .and_then(Value::as_str)
                    .map(|value| value == HOOK_PATH_SEND_TO_PEER)
                    .unwrap_or(false)
                    && mapping
                        .get("transform")
                        .and_then(Value::as_object)
                        .and_then(|value| value.get("module"))
                        .and_then(Value::as_str)
                        .map(|value| value == RELAY_MODULE_FILE_NAME)
                        .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn has_configured_secret_input(value: Option<&Value>) -> bool {
    value.is_some_and(|value| match value {
        Value::String(raw) => !raw.trim().is_empty(),
        Value::Object(object) => !object.is_empty(),
        _ => false,
    })
}

fn has_non_empty_env(name: &str) -> bool {
    std::env::var(name)
        .ok()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

fn trusted_proxy_ready(config: &Value) -> bool {
    let gateway = config.get("gateway").and_then(Value::as_object);
    let auth = gateway
        .and_then(|value| value.get("auth"))
        .and_then(Value::as_object);
    let user_header_ready = auth
        .and_then(|value| value.get("trustedProxy"))
        .and_then(Value::as_object)
        .and_then(|value| value.get("userHeader"))
        .and_then(Value::as_str)
        .map(str::trim)
        .is_some_and(|value| !value.is_empty());
    let trusted_proxies_ready = gateway
        .and_then(|value| value.get("trustedProxies"))
        .and_then(Value::as_array)
        .is_some_and(|entries| !entries.is_empty());
    user_header_ready && trusted_proxies_ready
}

fn explicit_gateway_auth_state(
    mode: &str,
    config: &Value,
    token_configured: bool,
    password_configured: bool,
) -> Option<(bool, String)> {
    match mode {
        "token" => Some((
            token_configured,
            if token_configured {
                "OpenClaw gateway token auth is configured".to_string()
            } else {
                "OpenClaw gateway token auth is missing".to_string()
            },
        )),
        "password" => Some((
            password_configured,
            if password_configured {
                "OpenClaw gateway password auth is configured".to_string()
            } else {
                "OpenClaw gateway password auth is missing".to_string()
            },
        )),
        "trusted-proxy" => {
            let trusted_proxy_ready = trusted_proxy_ready(config);
            Some((
                trusted_proxy_ready,
                if trusted_proxy_ready {
                    "OpenClaw trusted-proxy auth is configured".to_string()
                } else {
                    "OpenClaw trusted-proxy auth is missing required trusted proxy settings"
                        .to_string()
                },
            ))
        }
        "none" => Some((
            false,
            "OpenClaw gateway auth is disabled (`mode=none`)".to_string(),
        )),
        _ => None,
    }
}

fn inferred_gateway_auth_state(
    token_configured: bool,
    password_configured: bool,
) -> (bool, String) {
    match (token_configured, password_configured) {
        (true, false) => (
            true,
            "OpenClaw gateway auth is configured and will use token auth".to_string(),
        ),
        (false, true) => (
            true,
            "OpenClaw gateway auth is configured and will use password auth".to_string(),
        ),
        (true, true) => (
            false,
            "OpenClaw gateway auth has both token and password configured but no explicit mode"
                .to_string(),
        ),
        (false, false) => (false, "OpenClaw gateway auth is not configured".to_string()),
    }
}

fn gateway_auth_state(config: &Value) -> (bool, String) {
    let gateway_auth = config
        .get("gateway")
        .and_then(Value::as_object)
        .and_then(|value| value.get("auth"))
        .and_then(Value::as_object);
    let mode = gateway_auth
        .and_then(|value| value.get("mode"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let token_configured = has_non_empty_env("OPENCLAW_GATEWAY_TOKEN")
        || has_configured_secret_input(gateway_auth.and_then(|value| value.get("token")));
    let password_configured = has_non_empty_env("OPENCLAW_GATEWAY_PASSWORD")
        || has_configured_secret_input(gateway_auth.and_then(|value| value.get("password")));

    parse_gateway_auth_mode(mode)
        .and_then(|mode| {
            explicit_gateway_auth_state(mode, config, token_configured, password_configured)
        })
        .unwrap_or_else(|| inferred_gateway_auth_state(token_configured, password_configured))
}

fn install_check(
    id: &str,
    passed: bool,
    ok_message: String,
    error_message: String,
) -> (String, bool, String) {
    (
        id.to_string(),
        passed,
        if passed { ok_message } else { error_message },
    )
}

fn build_asset_presence_checks(openclaw_dir: &Path) -> Vec<(String, bool, String)> {
    let transform_path = transform_target_path(openclaw_dir);
    let skill_path = skill_root(openclaw_dir);
    let transform_present = transform_path.is_file();
    let skill_doc_present = skill_path.join("SKILL.md").is_file();
    vec![
        install_check(
            "state.transform",
            transform_present,
            format!(
                "relay transform module is present at {}",
                transform_path.display()
            ),
            format!(
                "relay transform module is missing at {}",
                transform_path.display()
            ),
        ),
        install_check(
            "state.skillArtifacts",
            skill_doc_present,
            format!(
                "OpenClaw skill artifacts are present at {}",
                skill_path.display()
            ),
            format!(
                "OpenClaw skill artifacts are missing at {}",
                skill_path.display()
            ),
        ),
    ]
}

fn hook_token_present(hooks: Option<&Map<String, Value>>) -> bool {
    hooks
        .and_then(|value| value.get("token"))
        .and_then(Value::as_str)
        .map(str::trim)
        .map(|value| !value.is_empty())
        .unwrap_or(false)
}

fn build_config_checks(
    hooks: Option<&Map<String, Value>>,
    mapping_present: bool,
    gateway_auth_ready: bool,
    gateway_auth_message: &str,
) -> Vec<(String, bool, String)> {
    vec![
        install_check(
            "state.hookToken",
            hook_token_present(hooks),
            "OpenClaw hook token is configured".to_string(),
            "OpenClaw hook token is missing".to_string(),
        ),
        install_check(
            "state.hookMapping",
            mapping_present,
            "send-to-peer relay mapping is configured".to_string(),
            "send-to-peer relay mapping is missing".to_string(),
        ),
        install_check(
            "state.hookSessionRouting",
            hook_session_routing_ready(hooks),
            "OpenClaw hook session routing is configured".to_string(),
            "OpenClaw hook session routing is missing required defaults".to_string(),
        ),
        install_check(
            "state.gatewayAuth",
            gateway_auth_ready,
            gateway_auth_message.to_string(),
            gateway_auth_message.to_string(),
        ),
    ]
}

fn build_install_checks(
    openclaw_dir: &Path,
    hooks: Option<&Map<String, Value>>,
    mapping_present: bool,
    gateway_auth_ready: bool,
    gateway_auth_message: &str,
) -> Vec<(String, bool, String)> {
    let mut checks = build_asset_presence_checks(openclaw_dir);
    checks.extend(build_config_checks(
        hooks,
        mapping_present,
        gateway_auth_ready,
        gateway_auth_message,
    ));
    checks
}

/// Return the OpenClaw skill installation root under the selected home directory.
pub fn skill_root(openclaw_dir: &Path) -> PathBuf {
    openclaw_dir.join("skills").join(SKILL_DIR_NAME)
}

/// Return the canonical OpenClaw transform-module path used by hooks.
pub fn transform_target_path(openclaw_dir: &Path) -> PathBuf {
    openclaw_dir
        .join("hooks")
        .join("transforms")
        .join(RELAY_MODULE_FILE_NAME)
}

fn transform_dir(openclaw_dir: &Path) -> PathBuf {
    openclaw_dir.join("hooks").join("transforms")
}

/// Return the runtime metadata file path used by the relay transform.
pub fn transform_runtime_path(openclaw_dir: &Path) -> PathBuf {
    transform_dir(openclaw_dir).join(RELAY_RUNTIME_FILE_NAME)
}

/// Return the peer snapshot file path used by the relay transform.
pub fn transform_peers_path(openclaw_dir: &Path) -> PathBuf {
    transform_dir(openclaw_dir).join(RELAY_PEERS_FILE_NAME)
}

fn is_container_fallback_host(host: &str) -> bool {
    matches!(
        host,
        CONNECTOR_HOST_LOOPBACK
            | CONNECTOR_HOST_LOCALHOST
            | CONNECTOR_HOST_DOCKER
            | CONNECTOR_HOST_DOCKER_GATEWAY
            | CONNECTOR_HOST_LINUX_BRIDGE
    )
}

fn connector_runtime_base_urls(connector_base_url: &str) -> Result<Vec<String>> {
    let normalized = url::Url::parse(connector_base_url.trim())
        .map_err(|_| CoreError::InvalidUrl {
            context: "connectorBaseUrl",
            value: connector_base_url.to_string(),
        })?
        .to_string();
    let parsed = url::Url::parse(&normalized).map_err(|_| CoreError::InvalidUrl {
        context: "connectorBaseUrl",
        value: connector_base_url.to_string(),
    })?;
    let Some(host) = parsed.host_str() else {
        return Ok(vec![normalized]);
    };

    if !is_container_fallback_host(host) {
        return Ok(vec![normalized]);
    }

    let mut urls = vec![normalized];
    for fallback_host in [
        CONNECTOR_HOST_DOCKER,
        CONNECTOR_HOST_DOCKER_GATEWAY,
        CONNECTOR_HOST_LINUX_BRIDGE,
        CONNECTOR_HOST_LOOPBACK,
        CONNECTOR_HOST_LOCALHOST,
    ] {
        let mut candidate = parsed.clone();
        if candidate.set_host(Some(fallback_host)).is_err() {
            continue;
        }
        let candidate = candidate.to_string();
        if !urls.iter().any(|value| value == &candidate) {
            urls.push(candidate);
        }
    }
    Ok(urls)
}

fn runtime_peers_config_path_value(openclaw_dir: &Path, peers_path: &Path) -> String {
    let transforms_dir = transform_dir(openclaw_dir);
    peers_path
        .strip_prefix(&transforms_dir)
        .map(|relative| relative.to_string_lossy().to_string())
        .unwrap_or_else(|_| peers_path.to_string_lossy().to_string())
}

fn hook_config_updates(
    hooks: &Map<String, Value>,
    preferred_hook_token: Option<&str>,
) -> Vec<(&'static str, Value)> {
    let resolved_hook_token = resolve_hook_token(hooks, preferred_hook_token);
    let default_session_key = resolve_default_session_key(hooks);
    let allowed_session_key_prefixes = Value::Array(target_allowed_session_key_prefixes(
        hooks,
        &default_session_key,
    ));
    let mappings = Value::Array(relay_mappings_with_upsert(read_existing_mappings(hooks)));

    vec![
        ("hooks.enabled", Value::Bool(true)),
        ("hooks.token", Value::String(resolved_hook_token)),
        (
            "hooks.defaultSessionKey",
            Value::String(default_session_key),
        ),
        ("hooks.allowRequestSessionKey", Value::Bool(false)),
        (
            "hooks.allowedSessionKeyPrefixes",
            allowed_session_key_prefixes,
        ),
        ("hooks.mappings", mappings),
    ]
}

fn apply_hook_config_updates(
    command_path: &Path,
    config_path: &Path,
    openclaw_dir: &Path,
    updates: &[(&str, Value)],
) -> Result<()> {
    for (path, value) in updates {
        run_openclaw_config_set_json(command_path, config_path, openclaw_dir, path, value)?;
    }
    Ok(())
}

/// Install or verify the OpenClaw skill bundle and relay transform assets.
pub fn install_openclaw_skill_assets(openclaw_dir: &Path) -> Result<Vec<String>> {
    openclaw_assets(openclaw_dir)?
        .iter()
        .map(note_install_result)
        .collect()
}

/// Patch the OpenClaw config so Clawdentity relay hook settings are present.
pub fn patch_openclaw_config(
    command_path: &Path,
    openclaw_dir: &Path,
    config_path: &Path,
    preferred_hook_token: Option<&str>,
) -> Result<OpenclawConfigPatchResult> {
    let mut config = parse_json_or_default(config_path)?;
    let root = ensure_object(&mut config)?;
    let hooks = ensure_object_key(root, "hooks")?;
    let updates = hook_config_updates(hooks, preferred_hook_token);
    let hook_token = updates
        .iter()
        .find_map(|(path, value)| match (*path, value) {
            ("hooks.token", Value::String(token)) => Some(token.as_str()),
            _ => None,
        })
        .unwrap_or_default();
    let default_session_key = updates
        .iter()
        .find_map(|(path, value)| match (*path, value) {
            ("hooks.defaultSessionKey", Value::String(session_key)) => Some(session_key.as_str()),
            _ => None,
        })
        .unwrap_or(DEFAULT_OPENCLAW_MAIN_SESSION_KEY);
    let changed = !hook_settings_match(hooks, hook_token, default_session_key);
    if changed {
        apply_hook_config_updates(command_path, config_path, openclaw_dir, &updates)?;
    }
    Ok(OpenclawConfigPatchResult {
        config_changed: changed,
    })
}

/// Read the configured OpenClaw hook token from the OpenClaw config file.
pub fn read_openclaw_config_hook_token(config_path: &Path) -> Result<Option<String>> {
    let config = parse_json_or_default(config_path)?;
    Ok(config
        .get("hooks")
        .and_then(Value::as_object)
        .and_then(|hooks| hooks.get("token"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned))
}

/// Write relay runtime metadata consumed by the OpenClaw hook transform.
pub fn write_transform_runtime_config(
    openclaw_dir: &Path,
    connector_base_url: &str,
    peers_path: &Path,
) -> Result<PathBuf> {
    let connector_base_urls = connector_runtime_base_urls(connector_base_url)?;
    let payload = json!({
        "version": 1,
        "connectorBaseUrl": connector_base_urls.first().cloned().unwrap_or_default(),
        "connectorBaseUrls": connector_base_urls,
        "connectorPath": DEFAULT_CONNECTOR_OUTBOUND_PATH,
        "peersConfigPath": runtime_peers_config_path_value(openclaw_dir, peers_path),
        "updatedAt": chrono::Utc::now().to_rfc3339(),
    });
    let target_path = transform_runtime_path(openclaw_dir);
    write_secure_bytes(
        &target_path,
        format!("{}\n", serde_json::to_string_pretty(&payload)?).as_bytes(),
    )?;
    Ok(target_path)
}

/// Write the peer snapshot consumed by the OpenClaw hook transform.
pub fn write_transform_peers_snapshot(peers_path: &Path, peers: &PeersConfig) -> Result<PathBuf> {
    write_secure_bytes(
        peers_path,
        format!("{}\n", serde_json::to_string_pretty(peers)?).as_bytes(),
    )?;
    Ok(peers_path.to_path_buf())
}

/// Verify that the OpenClaw relay install left the required files and config entries in place.
pub fn verify_openclaw_install(
    config_path: &Path,
    openclaw_dir: &Path,
) -> Result<Vec<(String, bool, String)>> {
    let config = parse_json_or_default(config_path)?;
    let hooks = read_hooks(&config);
    let mapping_present = hook_mapping_present(hooks);
    let (gateway_auth_ready, gateway_auth_message) = gateway_auth_state(&config);
    Ok(build_install_checks(
        openclaw_dir,
        hooks,
        mapping_present,
        gateway_auth_ready,
        &gateway_auth_message,
    ))
}

#[cfg(test)]
#[path = "assets_tests.rs"]
mod tests;
