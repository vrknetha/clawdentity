use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};

use crate::db::SqliteStore;
use crate::db::now_utc_ms;
use crate::db_verify_cache::{get_verify_cache_entry, upsert_verify_cache_entry};
use crate::did::{did_authority_from_url, parse_agent_did};
use crate::error::{CoreError, Result};
use crate::http::blocking_client;

pub const CRL_CACHE_TTL_MS: i64 = 15 * 60 * 1000;
const CRL_CACHE_KEY_PREFIX: &str = "crl::";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CrlVerificationKey {
    pub kid: String,
    pub x: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrlRevocation {
    pub jti: String,
    pub agent_did: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub revoked_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CrlClaims {
    pub iss: String,
    pub jti: String,
    pub iat: i64,
    pub exp: i64,
    pub revocations: Vec<CrlRevocation>,
}

#[derive(Debug, Deserialize)]
struct CrlResponse {
    crl: String,
}

fn parse_jwt_parts(token: &str) -> Result<(&str, &str, &str)> {
    let mut parts = token.split('.');
    let header = parts
        .next()
        .ok_or_else(|| CoreError::InvalidInput("CRL token is invalid".to_string()))?;
    let payload = parts
        .next()
        .ok_or_else(|| CoreError::InvalidInput("CRL token is invalid".to_string()))?;
    let signature = parts
        .next()
        .ok_or_else(|| CoreError::InvalidInput("CRL token is invalid".to_string()))?;
    if parts.next().is_some() {
        return Err(CoreError::InvalidInput("CRL token is invalid".to_string()));
    }
    Ok((header, payload, signature))
}

fn decode_base64url(value: &str, context: &str) -> Result<Vec<u8>> {
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| CoreError::InvalidInput(format!("{context} is invalid base64url")))
}

fn verify_jwt_payload(
    token: &str,
    keys: &[CrlVerificationKey],
    expected_issuer: Option<&str>,
) -> Result<serde_json::Value> {
    let (header_b64, payload_b64, signature_b64) = parse_jwt_parts(token)?;
    let header_bytes = decode_base64url(header_b64, "CRL header")?;
    let payload_bytes = decode_base64url(payload_b64, "CRL payload")?;
    let signature_bytes = decode_base64url(signature_b64, "CRL signature")?;

    let header: serde_json::Value = serde_json::from_slice(&header_bytes)
        .map_err(|_| CoreError::InvalidInput("CRL header is invalid".to_string()))?;
    let kid = header
        .get("kid")
        .and_then(|value| value.as_str())
        .ok_or_else(|| CoreError::InvalidInput("CRL header missing kid".to_string()))?;
    let key = keys
        .iter()
        .find(|candidate| candidate.kid == kid)
        .ok_or_else(|| CoreError::InvalidInput("CRL key id is unknown".to_string()))?;

    let public_key_bytes = decode_base64url(&key.x, "CRL key x")?;
    let public_key: [u8; 32] = public_key_bytes
        .try_into()
        .map_err(|_| CoreError::InvalidInput("CRL key x must decode to 32 bytes".to_string()))?;
    let verifying_key = VerifyingKey::from_bytes(&public_key)
        .map_err(|_| CoreError::InvalidInput("CRL key is invalid".to_string()))?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| CoreError::InvalidInput("CRL signature is invalid".to_string()))?;
    let signed_message = format!("{header_b64}.{payload_b64}");
    verifying_key
        .verify(signed_message.as_bytes(), &signature)
        .map_err(|_| CoreError::InvalidInput("CRL signature verification failed".to_string()))?;

    let payload: serde_json::Value = serde_json::from_slice(&payload_bytes)
        .map_err(|_| CoreError::InvalidInput("CRL payload is invalid".to_string()))?;
    if let Some(expected_issuer) = expected_issuer {
        let issuer = payload
            .get("iss")
            .and_then(|value| value.as_str())
            .ok_or_else(|| CoreError::InvalidInput("CRL payload missing iss".to_string()))?;
        if issuer != expected_issuer {
            return Err(CoreError::InvalidInput(
                "CRL issuer does not match expected issuer".to_string(),
            ));
        }
    }
    Ok(payload)
}

fn parse_crl_claims(payload: serde_json::Value) -> Result<CrlClaims> {
    let claims: CrlClaims = serde_json::from_value(payload)
        .map_err(|error| CoreError::InvalidInput(error.to_string()))?;
    if claims.exp <= claims.iat {
        return Err(CoreError::InvalidInput(
            "CRL claims exp must be greater than iat".to_string(),
        ));
    }
    let issuer_authority = did_authority_from_url(&claims.iss, "iss")?;
    for revocation in &claims.revocations {
        let parsed = parse_agent_did(&revocation.agent_did).map_err(|_| {
            CoreError::InvalidInput("CRL revocation agentDid must be an agent DID".to_string())
        })?;
        if parsed.authority != issuer_authority {
            return Err(CoreError::InvalidInput(
                "CRL revocation agentDid authority must match issuer host".to_string(),
            ));
        }
    }
    if claims.exp <= chrono::Utc::now().timestamp() {
        return Err(CoreError::InvalidInput("CRL token is expired".to_string()));
    }
    Ok(claims)
}

/// TODO(clawdentity): document `is_jti_revoked`.
pub fn is_jti_revoked(claims: &CrlClaims, jti: &str) -> bool {
    claims.revocations.iter().any(|entry| entry.jti == jti)
}

/// TODO(clawdentity): document `load_crl_claims`.
#[allow(clippy::too_many_lines)]
pub fn load_crl_claims(
    store: &SqliteStore,
    registry_url: &str,
    expected_issuer: Option<&str>,
    verification_keys: &[CrlVerificationKey],
) -> Result<CrlClaims> {
    if verification_keys.is_empty() {
        return Err(CoreError::InvalidInput(
            "at least one verification key is required".to_string(),
        ));
    }

    let cache_key = format!("{CRL_CACHE_KEY_PREFIX}{registry_url}");
    if let Some(cache_entry) = get_verify_cache_entry(store, &cache_key)? {
        let age_ms = now_utc_ms() - cache_entry.fetched_at_ms;
        if cache_entry.registry_url == registry_url
            && age_ms <= CRL_CACHE_TTL_MS
            && let Ok(claims) = serde_json::from_str::<CrlClaims>(&cache_entry.payload_json)
        {
            return Ok(claims);
        }
    }

    let request_url = url::Url::parse(registry_url)
        .map_err(|_| CoreError::InvalidUrl {
            context: "registryUrl",
            value: registry_url.to_string(),
        })?
        .join("/v1/crl")
        .map_err(|_| CoreError::InvalidUrl {
            context: "registryUrl",
            value: registry_url.to_string(),
        })?;
    let response = blocking_client()?
        .get(request_url)
        .send()
        .map_err(|error| CoreError::Http(error.to_string()))?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let message = response
            .text()
            .unwrap_or_else(|_| "failed to fetch CRL".to_string());
        return Err(CoreError::HttpStatus { status, message });
    }
    let payload = response
        .json::<CrlResponse>()
        .map_err(|error| CoreError::Http(error.to_string()))?;
    let verified_payload = verify_jwt_payload(&payload.crl, verification_keys, expected_issuer)?;
    let claims = parse_crl_claims(verified_payload)?;
    upsert_verify_cache_entry(
        store,
        &cache_key,
        registry_url,
        &serde_json::to_string(&claims)?,
    )?;
    Ok(claims)
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

    use super::{CrlVerificationKey, load_crl_claims};

    fn sign_crl_token(registry_url: &str, signer: &SigningKey, kid: &str) -> String {
        let authority = url::Url::parse(registry_url)
            .ok()
            .and_then(|value| value.host_str().map(ToOwned::to_owned))
            .expect("registry host");
        let header = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&serde_json::json!({
                "alg":"EdDSA",
                "typ":"JWT",
                "kid": kid,
            }))
            .expect("header"),
        );
        let payload = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&serde_json::json!({
                "iss": registry_url,
                "jti": "01HF7YAT00W6W7CM7N3W5FDXT4",
                "iat": 1_700_000_000_i64,
                "exp": 2_208_988_800_i64,
                "revocations": [{
                    "jti":"01HF7YAT00W6W7CM7N3W5FDXT5",
                    "agentDid": format!("did:cdi:{authority}:agent:01HF7YAT00W6W7CM7N3W5FDXT6"),
                    "revokedAt": 1_700_000_010_i64
                }]
            }))
            .expect("payload"),
        );
        let signature = URL_SAFE_NO_PAD.encode(
            signer
                .sign(format!("{header}.{payload}").as_bytes())
                .to_bytes(),
        );
        format!("{header}.{payload}.{signature}")
    }

    #[tokio::test]
    async fn fetches_verifies_and_caches_crl_claims() {
        let server = MockServer::start().await;
        let signing_key = SigningKey::from_bytes(&[5_u8; 32]);
        let token = sign_crl_token(&server.uri(), &signing_key, "reg-key-1");
        Mock::given(method("GET"))
            .and(path("/v1/crl"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "crl": token
            })))
            .mount(&server)
            .await;

        let temp = TempDir::new().expect("temp dir");
        let store = SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("db");
        let store_for_claims = store.clone();
        let server_uri = server.uri();
        let expected_issuer = server.uri();
        let key = CrlVerificationKey {
            kid: "reg-key-1".to_string(),
            x: URL_SAFE_NO_PAD.encode(signing_key.verifying_key().as_bytes()),
        };
        let claims = tokio::task::spawn_blocking(move || {
            load_crl_claims(
                &store_for_claims,
                &server_uri,
                Some(&expected_issuer),
                &[key],
            )
        })
        .await
        .expect("join")
        .expect("claims");
        assert_eq!(claims.revocations.len(), 1);
    }
}
