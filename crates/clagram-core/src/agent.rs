use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{SigningKey, VerifyingKey};
use getrandom::fill as getrandom_fill;
use serde::{Deserialize, Serialize};
use ulid::Ulid;

use crate::config::{ConfigPathOptions, get_config_dir, resolve_config};
use crate::did::make_did_for_registry_host;
use crate::error::{CoreError, Result};

const AGENTS_DIR: &str = "agents";
const FILE_MODE: u32 = 0o600;
const IDENTITY_FILE: &str = "identity.json";
const AIT_FILE: &str = "ait.jwt";
const SECRET_KEY_FILE: &str = "secret.key";
const PUBLIC_KEY_FILE: &str = "public.key";
const REGISTRY_AUTH_FILE: &str = "registry-auth.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentIdentityRecord {
    pub did: String,
    pub name: String,
    pub framework: String,
    pub expires_at: String,
    pub registry_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAuthRecord {
    pub refresh_token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_expires_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCreateResult {
    pub name: String,
    pub did: String,
    pub expires_at: String,
    pub framework: String,
    pub registry_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInspectResult {
    pub did: String,
    pub owner_did: String,
    pub expires_at: String,
    pub key_id: String,
    pub public_key: String,
    pub framework: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAuthRefreshResult {
    pub name: String,
    pub status: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAuthRevokeResult {
    pub name: String,
    pub status: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateAgentInput {
    pub name: String,
    pub framework: Option<String>,
    pub ttl_days: Option<u32>,
}

fn set_secure_permissions(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = fs::Permissions::from_mode(FILE_MODE);
        fs::set_permissions(path, perms).map_err(|source| CoreError::Io {
            path: path.to_path_buf(),
            source,
        })?;
    }
    Ok(())
}

fn write_secure_text(path: &Path, contents: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|source| CoreError::Io {
            path: parent.to_path_buf(),
            source,
        })?;
    }
    fs::write(path, contents).map_err(|source| CoreError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    set_secure_permissions(path)?;
    Ok(())
}

fn write_secure_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let body = serde_json::to_string_pretty(value)?;
    write_secure_text(path, &format!("{body}\n"))
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T> {
    let raw = fs::read_to_string(path).map_err(|source| CoreError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    serde_json::from_str::<T>(&raw).map_err(|source| CoreError::JsonParse {
        path: path.to_path_buf(),
        source,
    })
}

fn parse_agent_name(name: &str) -> Result<String> {
    let candidate = name.trim();
    if candidate.is_empty() {
        return Err(CoreError::InvalidInput(
            "agent name is required".to_string(),
        ));
    }
    if candidate.len() > 64 {
        return Err(CoreError::InvalidInput(
            "agent name must be <= 64 characters".to_string(),
        ));
    }
    let valid = candidate
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.');
    if !valid {
        return Err(CoreError::InvalidInput(
            "agent name contains invalid characters".to_string(),
        ));
    }
    Ok(candidate.to_string())
}

fn agents_dir(options: &ConfigPathOptions) -> Result<PathBuf> {
    Ok(get_config_dir(options)?.join(AGENTS_DIR))
}

fn agent_dir(options: &ConfigPathOptions, name: &str) -> Result<PathBuf> {
    Ok(agents_dir(options)?.join(name))
}

fn now_unix_seconds() -> Result<u64> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| CoreError::InvalidInput(error.to_string()))?
        .as_secs())
}

fn unix_seconds_to_iso(seconds: u64) -> Result<String> {
    let dt = UNIX_EPOCH
        .checked_add(Duration::from_secs(seconds))
        .ok_or_else(|| CoreError::InvalidInput("invalid timestamp".to_string()))?;
    let datetime: chrono::DateTime<chrono::Utc> = dt.into();
    Ok(datetime.to_rfc3339())
}

fn default_framework(value: Option<String>) -> String {
    value
        .and_then(|raw| {
            let trimmed = raw.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        })
        .unwrap_or_else(|| "openclaw".to_string())
}

fn ttl_days(value: Option<u32>) -> u32 {
    value.unwrap_or(30).max(1)
}

fn encode_jwt(header: serde_json::Value, payload: serde_json::Value) -> Result<String> {
    let header_raw = serde_json::to_vec(&header)?;
    let payload_raw = serde_json::to_vec(&payload)?;
    let encoded_header = URL_SAFE_NO_PAD.encode(header_raw);
    let encoded_payload = URL_SAFE_NO_PAD.encode(payload_raw);
    Ok(format!("{encoded_header}.{encoded_payload}.local"))
}

fn decode_jwt_payload(token: &str) -> Result<serde_json::Value> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() < 2 {
        return Err(CoreError::InvalidInput("invalid AIT token".to_string()));
    }
    let payload = URL_SAFE_NO_PAD
        .decode(parts[1])
        .map_err(|error| CoreError::Base64Decode(error.to_string()))?;
    serde_json::from_slice(&payload).map_err(|error| CoreError::InvalidInput(error.to_string()))
}

fn decode_jwt_header(token: &str) -> Result<serde_json::Value> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.is_empty() {
        return Err(CoreError::InvalidInput("invalid AIT token".to_string()));
    }
    let header = URL_SAFE_NO_PAD
        .decode(parts[0])
        .map_err(|error| CoreError::Base64Decode(error.to_string()))?;
    serde_json::from_slice(&header).map_err(|error| CoreError::InvalidInput(error.to_string()))
}

pub fn create_agent(
    options: &ConfigPathOptions,
    input: CreateAgentInput,
) -> Result<AgentCreateResult> {
    let config = resolve_config(options)?;
    if config.api_key.is_none() {
        return Err(CoreError::InvalidInput(
            "API key is not configured. Run `clagram config set apiKey <token>` first.".to_string(),
        ));
    }

    let name = parse_agent_name(&input.name)?;
    let state_options = options.with_registry_hint(config.registry_url.clone());
    let agent_directory = agent_dir(&state_options, &name)?;
    if agent_directory.exists() {
        return Err(CoreError::IdentityAlreadyExists(agent_directory));
    }

    fs::create_dir_all(&agent_directory).map_err(|source| CoreError::Io {
        path: agent_directory.clone(),
        source,
    })?;

    let framework = default_framework(input.framework);
    let ttl_days = ttl_days(input.ttl_days);
    let expires_unix = now_unix_seconds()? + (ttl_days as u64 * 24 * 60 * 60);
    let expires_at = unix_seconds_to_iso(expires_unix)?;

    let mut secret_bytes = [0_u8; 32];
    getrandom_fill(&mut secret_bytes)
        .map_err(|error| CoreError::InvalidInput(error.to_string()))?;
    let signing_key = SigningKey::from_bytes(&secret_bytes);
    let verifying_key: VerifyingKey = signing_key.verifying_key();
    let public_key = URL_SAFE_NO_PAD.encode(verifying_key.as_bytes());
    let secret_key = URL_SAFE_NO_PAD.encode(signing_key.to_bytes());

    let did = make_did_for_registry_host(&config.registry_url)?;
    let owner_did = make_did_for_registry_host(&config.registry_url)?;
    let kid = format!("agent-{}", Ulid::new());
    let ait = encode_jwt(
        serde_json::json!({
            "alg": "EdDSA",
            "typ": "JWT",
            "kid": kid,
        }),
        serde_json::json!({
            "sub": did,
            "ownerDid": owner_did,
            "exp": expires_unix,
            "framework": framework,
            "cnf": { "jwk": { "kty": "OKP", "crv": "Ed25519", "x": public_key } }
        }),
    )?;

    let identity = AgentIdentityRecord {
        did: did.clone(),
        name: name.clone(),
        framework: framework.clone(),
        expires_at: expires_at.clone(),
        registry_url: config.registry_url.clone(),
    };
    let auth = AgentAuthRecord {
        refresh_token: "not-provisioned".to_string(),
        access_token: None,
        access_expires_at: None,
        refresh_expires_at: None,
    };

    write_secure_json(&agent_directory.join(IDENTITY_FILE), &identity)?;
    write_secure_text(&agent_directory.join(AIT_FILE), &ait)?;
    write_secure_text(&agent_directory.join(SECRET_KEY_FILE), &secret_key)?;
    write_secure_text(&agent_directory.join(PUBLIC_KEY_FILE), &public_key)?;
    write_secure_json(&agent_directory.join(REGISTRY_AUTH_FILE), &auth)?;

    Ok(AgentCreateResult {
        name,
        did,
        expires_at,
        framework,
        registry_url: config.registry_url,
    })
}

pub fn inspect_agent(options: &ConfigPathOptions, name: &str) -> Result<AgentInspectResult> {
    let name = parse_agent_name(name)?;
    let agent_directory = agent_dir(options, &name)?;
    let ait_path = agent_directory.join(AIT_FILE);
    let raw = fs::read_to_string(&ait_path).map_err(|source| CoreError::Io {
        path: ait_path.clone(),
        source,
    })?;
    let token = raw.trim();
    let header = decode_jwt_header(token)?;
    let payload = decode_jwt_payload(token)?;

    let did = payload
        .get("sub")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    let owner_did = payload
        .get("ownerDid")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    let framework = payload
        .get("framework")
        .and_then(|value| value.as_str())
        .unwrap_or("openclaw")
        .to_string();
    let public_key = payload
        .get("cnf")
        .and_then(|value| value.get("jwk"))
        .and_then(|value| value.get("x"))
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    let key_id = header
        .get("kid")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    let exp = payload
        .get("exp")
        .and_then(|value| value.as_u64())
        .unwrap_or_default();
    let expires_at = unix_seconds_to_iso(exp)?;

    if did.is_empty() || owner_did.is_empty() || key_id.is_empty() || public_key.is_empty() {
        return Err(CoreError::InvalidInput(
            "agent AIT payload is invalid".to_string(),
        ));
    }

    Ok(AgentInspectResult {
        did,
        owner_did,
        expires_at,
        key_id,
        public_key,
        framework,
    })
}

pub fn refresh_agent_auth(
    options: &ConfigPathOptions,
    name: &str,
) -> Result<AgentAuthRefreshResult> {
    let name = parse_agent_name(name)?;
    let agent_directory = agent_dir(options, &name)?;
    let auth_path = agent_directory.join(REGISTRY_AUTH_FILE);
    let mut auth: AgentAuthRecord = read_json(&auth_path)?;
    auth.refresh_token = "not-yet-supported".to_string();
    write_secure_json(&auth_path, &auth)?;

    Ok(AgentAuthRefreshResult {
        name,
        status: "not_supported".to_string(),
        message: "not yet supported by registry".to_string(),
    })
}

pub fn revoke_agent_auth(options: &ConfigPathOptions, name: &str) -> Result<AgentAuthRevokeResult> {
    let name = parse_agent_name(name)?;
    let agent_directory = agent_dir(options, &name)?;
    let auth_path = agent_directory.join(REGISTRY_AUTH_FILE);
    let mut auth: AgentAuthRecord = read_json(&auth_path)?;
    auth.access_token = None;
    auth.access_expires_at = None;
    write_secure_json(&auth_path, &auth)?;

    Ok(AgentAuthRevokeResult {
        name,
        status: "not_supported".to_string(),
        message: "not yet supported by registry".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use tempfile::TempDir;

    use crate::config::{CliConfig, ConfigPathOptions, write_config};

    use super::{
        CreateAgentInput, create_agent, inspect_agent, refresh_agent_auth, revoke_agent_auth,
    };

    fn options(home: &Path) -> ConfigPathOptions {
        ConfigPathOptions {
            home_dir: Some(home.to_path_buf()),
            registry_url_hint: Some("https://registry.clagram.com".to_string()),
        }
    }

    fn seed_config(options: &ConfigPathOptions) {
        let config = CliConfig {
            registry_url: "https://registry.clagram.com".to_string(),
            proxy_url: None,
            api_key: Some("local-key".to_string()),
            human_name: Some("alice".to_string()),
        };
        let _ = write_config(&config, options).expect("seed config");
    }

    #[test]
    fn create_and_inspect_agent_round_trip() {
        let tmp = TempDir::new().expect("temp dir");
        let options = options(tmp.path());
        seed_config(&options);

        let created = create_agent(
            &options,
            CreateAgentInput {
                name: "alpha".to_string(),
                framework: Some("openclaw".to_string()),
                ttl_days: Some(7),
            },
        )
        .expect("create");
        assert_eq!(created.name, "alpha");

        let inspect = inspect_agent(&options, "alpha").expect("inspect");
        assert_eq!(inspect.framework, "openclaw");
        assert_eq!(inspect.did, created.did);
    }

    #[test]
    fn auth_commands_return_not_supported() {
        let tmp = TempDir::new().expect("temp dir");
        let options = options(tmp.path());
        seed_config(&options);
        let _ = create_agent(
            &options,
            CreateAgentInput {
                name: "beta".to_string(),
                framework: None,
                ttl_days: None,
            },
        )
        .expect("create");

        let refresh = refresh_agent_auth(&options, "beta").expect("refresh");
        assert_eq!(refresh.status, "not_supported");

        let revoke = revoke_agent_auth(&options, "beta").expect("revoke");
        assert_eq!(revoke.status, "not_supported");
    }
}
