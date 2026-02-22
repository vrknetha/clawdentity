use std::fs;
use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};

use crate::crl::{CrlVerificationKey, is_jti_revoked, load_crl_claims};
use crate::db::SqliteStore;
use crate::db::now_utc_ms;
use crate::db_verify_cache::{get_verify_cache_entry, upsert_verify_cache_entry};
use crate::did::{ClawDidKind, parse_did};
use crate::error::{CoreError, Result};

pub const REGISTRY_KEYS_CACHE_TTL_MS: i64 = 60 * 60 * 1000;
const REGISTRY_KEYS_CACHE_KEY_PREFIX: &str = "registry-keys::";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrySigningKey {
    pub kid: String,
    pub alg: String,
    pub crv: String,
    pub x: String,
    pub status: String,
}

#[derive(Debug, Deserialize)]
struct RegistryKeysResponse {
    keys: Vec<RegistrySigningKey>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryVerificationKey {
    pub kid: String,
    pub x: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedAitClaims {
    pub iss: String,
    pub sub: String,
    pub owner_did: String,
    pub jti: String,
    pub exp: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifyResult {
    pub passed: bool,
    pub reason: String,
    pub claims: Option<VerifiedAitClaims>,
}

fn normalize_registry_url(registry_url: &str) -> Result<String> {
    url::Url::parse(registry_url)
        .map(|value| value.to_string())
        .map_err(|_| CoreError::InvalidUrl {
            context: "registryUrl",
            value: registry_url.to_string(),
        })
}

pub fn expected_issuer_for_registry(registry_url: &str) -> Option<String> {
    let parsed = url::Url::parse(registry_url).ok()?;
    match parsed.host_str()? {
        "registry.clawdentity.com" => Some("https://registry.clawdentity.com".to_string()),
        "dev.registry.clawdentity.com" => Some("https://dev.registry.clawdentity.com".to_string()),
        _ => None,
    }
}

fn resolve_token(token_or_file: &str) -> Result<String> {
    let candidate = token_or_file.trim();
    if candidate.is_empty() {
        return Err(CoreError::InvalidInput("token value is empty".to_string()));
    }

    let path = Path::new(candidate);
    if path.exists() {
        let raw = fs::read_to_string(path).map_err(|source| CoreError::Io {
            path: path.to_path_buf(),
            source,
        })?;
        let token = raw.trim();
        if token.is_empty() {
            return Err(CoreError::InvalidInput("token file is empty".to_string()));
        }
        return Ok(token.to_string());
    }

    Ok(candidate.to_string())
}

fn parse_active_verification_keys(keys: &[RegistrySigningKey]) -> Vec<RegistryVerificationKey> {
    keys.iter()
        .filter(|key| key.status == "active")
        .map(|key| RegistryVerificationKey {
            kid: key.kid.clone(),
            x: key.x.clone(),
        })
        .collect()
}

fn load_registry_keys(store: &SqliteStore, registry_url: &str) -> Result<Vec<RegistrySigningKey>> {
    let cache_key = format!("{REGISTRY_KEYS_CACHE_KEY_PREFIX}{registry_url}");
    if let Some(cache_entry) = get_verify_cache_entry(store, &cache_key)? {
        let age_ms = now_utc_ms() - cache_entry.fetched_at_ms;
        if cache_entry.registry_url == registry_url && age_ms <= REGISTRY_KEYS_CACHE_TTL_MS {
            if let Ok(keys) =
                serde_json::from_str::<Vec<RegistrySigningKey>>(&cache_entry.payload_json)
            {
                return Ok(keys);
            }
        }
    }

    let request_url = url::Url::parse(registry_url)
        .map_err(|_| CoreError::InvalidUrl {
            context: "registryUrl",
            value: registry_url.to_string(),
        })?
        .join("/.well-known/claw-keys.json")
        .map_err(|_| CoreError::InvalidUrl {
            context: "registryUrl",
            value: registry_url.to_string(),
        })?;
    let response = reqwest::blocking::Client::new()
        .get(request_url)
        .send()
        .map_err(|error| CoreError::Http(error.to_string()))?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let message = response
            .text()
            .unwrap_or_else(|_| "verification keys unavailable".to_string());
        return Err(CoreError::HttpStatus { status, message });
    }
    let payload = response
        .json::<RegistryKeysResponse>()
        .map_err(|error| CoreError::Http(error.to_string()))?;
    if payload.keys.is_empty() {
        return Err(CoreError::InvalidInput(
            "verification keys unavailable (no signing keys)".to_string(),
        ));
    }
    upsert_verify_cache_entry(
        store,
        &cache_key,
        registry_url,
        &serde_json::to_string(&payload.keys)?,
    )?;
    Ok(payload.keys)
}

fn decode_base64url(value: &str, context: &str) -> Result<Vec<u8>> {
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| CoreError::InvalidInput(format!("{context} is invalid base64url")))
}

fn verify_ait_token(
    token: &str,
    keys: &[RegistryVerificationKey],
    expected_issuer: Option<&str>,
) -> Result<VerifiedAitClaims> {
    if keys.is_empty() {
        return Err(CoreError::InvalidInput(
            "verification keys unavailable (no active keys)".to_string(),
        ));
    }

    let mut parts = token.split('.');
    let header_b64 = parts
        .next()
        .ok_or_else(|| CoreError::InvalidInput("invalid token".to_string()))?;
    let payload_b64 = parts
        .next()
        .ok_or_else(|| CoreError::InvalidInput("invalid token".to_string()))?;
    let signature_b64 = parts
        .next()
        .ok_or_else(|| CoreError::InvalidInput("invalid token".to_string()))?;
    if parts.next().is_some() {
        return Err(CoreError::InvalidInput("invalid token".to_string()));
    }

    let header_bytes = decode_base64url(header_b64, "token header")?;
    let payload_bytes = decode_base64url(payload_b64, "token payload")?;
    let signature_bytes = decode_base64url(signature_b64, "token signature")?;

    let header: serde_json::Value = serde_json::from_slice(&header_bytes)
        .map_err(|_| CoreError::InvalidInput("invalid token header".to_string()))?;
    let kid = header
        .get("kid")
        .and_then(|value| value.as_str())
        .ok_or_else(|| CoreError::InvalidInput("invalid token header (missing kid)".to_string()))?;
    let key = keys
        .iter()
        .find(|key| key.kid == kid)
        .ok_or_else(|| CoreError::InvalidInput("invalid token (unknown kid)".to_string()))?;

    let public_key_bytes = decode_base64url(&key.x, "verification key")?;
    let public_key: [u8; 32] = public_key_bytes
        .try_into()
        .map_err(|_| CoreError::InvalidInput("verification key is invalid".to_string()))?;
    let verifying_key = VerifyingKey::from_bytes(&public_key)
        .map_err(|_| CoreError::InvalidInput("verification key is invalid".to_string()))?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| CoreError::InvalidInput("invalid token signature".to_string()))?;
    verifying_key
        .verify(format!("{header_b64}.{payload_b64}").as_bytes(), &signature)
        .map_err(|_| CoreError::InvalidInput("invalid token signature".to_string()))?;

    let claims: VerifiedAitClaims = serde_json::from_slice(&payload_bytes)
        .map_err(|_| CoreError::InvalidInput("invalid token payload".to_string()))?;
    if claims.exp <= chrono::Utc::now().timestamp() {
        return Err(CoreError::InvalidInput("token is expired".to_string()));
    }
    if let Some(expected_issuer) = expected_issuer {
        if claims.iss != expected_issuer {
            return Err(CoreError::InvalidInput(
                "token issuer does not match expected issuer".to_string(),
            ));
        }
    }

    let sub = parse_did(&claims.sub)?;
    if sub.kind != ClawDidKind::Agent {
        return Err(CoreError::InvalidInput(
            "token sub must be an agent DID".to_string(),
        ));
    }
    let owner = parse_did(&claims.owner_did)?;
    if owner.kind != ClawDidKind::Human {
        return Err(CoreError::InvalidInput(
            "token ownerDid must be a human DID".to_string(),
        ));
    }

    Ok(claims)
}

pub fn verify_ait_token_with_registry(
    store: &SqliteStore,
    registry_url: &str,
    token_or_file: &str,
) -> Result<VerifyResult> {
    let registry_url = normalize_registry_url(registry_url)?;
    let token = resolve_token(token_or_file)?;
    let expected_issuer = expected_issuer_for_registry(&registry_url);

    let keys = load_registry_keys(store, &registry_url)?;
    let verification_keys = parse_active_verification_keys(&keys);
    let claims = match verify_ait_token(&token, &verification_keys, expected_issuer.as_deref()) {
        Ok(claims) => claims,
        Err(error) => {
            return Ok(VerifyResult {
                passed: false,
                reason: error.to_string(),
                claims: None,
            });
        }
    };

    let crl_keys = verification_keys
        .iter()
        .map(|key| CrlVerificationKey {
            kid: key.kid.clone(),
            x: key.x.clone(),
        })
        .collect::<Vec<_>>();
    let crl_claims = load_crl_claims(store, &registry_url, expected_issuer.as_deref(), &crl_keys)?;
    if is_jti_revoked(&crl_claims, &claims.jti) {
        return Ok(VerifyResult {
            passed: false,
            reason: "revoked".to_string(),
            claims: Some(claims),
        });
    }

    Ok(VerifyResult {
        passed: true,
        reason: format!("token verified ({})", claims.sub),
        claims: Some(claims),
    })
}

#[cfg(test)]
mod tests {
    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use ed25519_dalek::{Signer, SigningKey};
    use tempfile::TempDir;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use crate::db::SqliteStore;

    use super::verify_ait_token_with_registry;

    fn sign_jwt_token(
        _issuer: &str,
        kid: &str,
        signer: &SigningKey,
        claims: serde_json::Value,
    ) -> String {
        let header = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&serde_json::json!({
                "alg":"EdDSA",
                "typ":"JWT",
                "kid": kid,
            }))
            .expect("header"),
        );
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).expect("claims"));
        let signature = URL_SAFE_NO_PAD.encode(
            signer
                .sign(format!("{header}.{payload}").as_bytes())
                .to_bytes(),
        );
        format!("{header}.{payload}.{signature}")
    }

    #[tokio::test]
    async fn verifies_token_with_registry_keys_and_crl() {
        let server = MockServer::start().await;
        let signing_key = SigningKey::from_bytes(&[9_u8; 32]);
        let public_key = URL_SAFE_NO_PAD.encode(signing_key.verifying_key().as_bytes());
        let ait_claims = serde_json::json!({
            "iss": server.uri(),
            "sub": "did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
            "ownerDid": "did:claw:human:01HF7YAT31JZHSMW1CG6Q6MHB7",
            "jti": "01HF7YAT00W6W7CM7N3W5FDXT5",
            "exp": 2_208_988_800_i64
        });
        let ait_token = sign_jwt_token(&server.uri(), "reg-key-1", &signing_key, ait_claims);
        let crl_claims = serde_json::json!({
            "iss": server.uri(),
            "jti": "01HF7YAT00W6W7CM7N3W5FDXT6",
            "iat": 1_700_000_000_i64,
            "exp": 2_208_988_800_i64,
            "revocations": [{
                "jti":"01HF7YAT00W6W7CM7N3W5FDXT9",
                "agentDid":"did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
                "revokedAt": 1_700_000_100_i64
            }]
        });
        let crl_token = sign_jwt_token(&server.uri(), "reg-key-1", &signing_key, crl_claims);

        Mock::given(method("GET"))
            .and(path("/.well-known/claw-keys.json"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "keys": [{
                    "kid": "reg-key-1",
                    "alg": "EdDSA",
                    "crv": "Ed25519",
                    "x": public_key,
                    "status": "active"
                }]
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/crl"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "crl": crl_token
            })))
            .mount(&server)
            .await;

        let temp = TempDir::new().expect("temp dir");
        let store = SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("db");
        let store_for_verify = store.clone();
        let server_uri = server.uri();
        let result = tokio::task::spawn_blocking(move || {
            verify_ait_token_with_registry(&store_for_verify, &server_uri, &ait_token)
        })
        .await
        .expect("join")
        .expect("verify");
        assert!(result.passed);
    }
}
