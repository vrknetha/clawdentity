use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{SigningKey, VerifyingKey};
use getrandom::fill as getrandom_fill;
use serde::{Deserialize, Serialize};

use crate::config::{CliConfig, ConfigPathOptions, get_config_dir, resolve_config, write_config};
use crate::did::make_human_did;
use crate::error::{CoreError, Result};

const IDENTITY_FILE: &str = "identity.json";
const FILE_MODE: u32 = 0o600;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalIdentity {
    pub did: String,
    pub public_key: String,
    pub secret_key: String,
    pub registry_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicIdentityView {
    pub did: String,
    pub public_key: String,
    pub registry_url: String,
}

impl LocalIdentity {
/// TODO(clawdentity): document `public_view`.
    pub fn public_view(&self) -> PublicIdentityView {
        PublicIdentityView {
            did: self.did.clone(),
            public_key: self.public_key.clone(),
            registry_url: self.registry_url.clone(),
        }
    }
}

fn identity_path(options: &ConfigPathOptions) -> Result<PathBuf> {
    Ok(get_config_dir(options)?.join(IDENTITY_FILE))
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

fn write_secure_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|source| CoreError::Io {
            path: parent.to_path_buf(),
            source,
        })?;
    }
    let raw = serde_json::to_string_pretty(value)?;
    fs::write(path, format!("{raw}\n")).map_err(|source| CoreError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    set_secure_permissions(path)?;
    Ok(())
}

/// TODO(clawdentity): document `decode_secret_key`.
pub fn decode_secret_key(value: &str) -> Result<SigningKey> {
    let raw = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|error| CoreError::Base64Decode(error.to_string()))?;
    let bytes: [u8; 32] = raw
        .try_into()
        .map_err(|_| CoreError::InvalidInput("secret key must decode to 32 bytes".to_string()))?;
    Ok(SigningKey::from_bytes(&bytes))
}

/// TODO(clawdentity): document `init_identity`.
pub fn init_identity(
    options: &ConfigPathOptions,
    registry_url_override: Option<String>,
) -> Result<LocalIdentity> {
    let mut config = resolve_config(options)?;
    if let Some(override_url) = registry_url_override {
        let trimmed = override_url.trim().to_string();
        if trimmed.is_empty() {
            return Err(CoreError::InvalidInput(
                "registryUrl cannot be empty".to_string(),
            ));
        }
        config.registry_url = trimmed;
    }

    let state_options = options.with_registry_hint(config.registry_url.clone());
    let path = identity_path(&state_options)?;
    if path.exists() {
        return Err(CoreError::IdentityAlreadyExists(path));
    }

    let mut secret_bytes = [0_u8; 32];
    getrandom_fill(&mut secret_bytes)
        .map_err(|error| CoreError::InvalidInput(error.to_string()))?;
    let signing_key = SigningKey::from_bytes(&secret_bytes);
    let verifying_key: VerifyingKey = signing_key.verifying_key();

    let did = make_human_did();
    let identity = LocalIdentity {
        did,
        public_key: URL_SAFE_NO_PAD.encode(verifying_key.as_bytes()),
        secret_key: URL_SAFE_NO_PAD.encode(signing_key.to_bytes()),
        registry_url: config.registry_url.clone(),
    };

    write_secure_json(&path, &identity)?;
    let _ = write_config(
        &CliConfig {
            registry_url: config.registry_url,
            proxy_url: config.proxy_url,
            api_key: config.api_key,
            human_name: config.human_name,
        },
        options,
    )?;
    Ok(identity)
}

/// TODO(clawdentity): document `read_identity`.
pub fn read_identity(options: &ConfigPathOptions) -> Result<LocalIdentity> {
    let path = identity_path(options)?;
    let raw = fs::read_to_string(&path).map_err(|source| {
        if source.kind() == std::io::ErrorKind::NotFound {
            return CoreError::IdentityNotFound(path.clone());
        }
        CoreError::Io {
            path: path.clone(),
            source,
        }
    })?;

    serde_json::from_str::<LocalIdentity>(&raw)
        .map_err(|source| CoreError::JsonParse { path, source })
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use crate::config::ConfigPathOptions;

    use super::{decode_secret_key, init_identity, read_identity};

    fn options(home: &std::path::Path) -> ConfigPathOptions {
        ConfigPathOptions {
            home_dir: Some(home.to_path_buf()),
            registry_url_hint: Some("https://registry.clawdentity.com".to_string()),
        }
    }

    #[test]
    fn init_identity_creates_identity_and_can_read_it() {
        let tmp = TempDir::new().expect("temp dir");
        let opts = options(tmp.path());

        let created = init_identity(&opts, None).expect("identity should initialize");
        let loaded = read_identity(&opts).expect("identity should load");
        assert_eq!(created.did, loaded.did);
        assert_eq!(created.public_key, loaded.public_key);
    }

    #[test]
    fn decode_secret_key_accepts_generated_material() {
        let tmp = TempDir::new().expect("temp dir");
        let opts = options(tmp.path());
        let created = init_identity(&opts, None).expect("identity should initialize");
        let key = decode_secret_key(&created.secret_key).expect("secret key should decode");
        assert_eq!(key.to_bytes().len(), 32);
    }
}
