use axum::http::HeaderMap;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signer, SigningKey};
use getrandom::fill as getrandom_fill;
use serde_json::{Value, json};
use ulid::Ulid;

use crate::state::SigningMaterial;

pub(crate) fn generate_signing_material() -> Result<SigningMaterial, String> {
    let mut secret = [0_u8; 32];
    getrandom_fill(&mut secret)
        .map_err(|error| format!("failed to generate signing key: {error}"))?;
    let signing_key = SigningKey::from_bytes(&secret);
    let public_key_x = URL_SAFE_NO_PAD.encode(signing_key.verifying_key().as_bytes());
    Ok(SigningMaterial {
        kid: "reg-key-1".to_string(),
        signing_key,
        public_key_x,
    })
}

pub(crate) fn sign_jwt(signing: &SigningMaterial, payload: &Value) -> Result<String, String> {
    let header_b64 = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&json!({
            "alg": "EdDSA",
            "typ": "JWT",
            "kid": signing.kid,
        }))
        .map_err(|error| format!("failed to encode jwt header: {error}"))?,
    );
    let payload_b64 = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(payload)
            .map_err(|error| format!("failed to encode jwt payload: {error}"))?,
    );
    let signing_input = format!("{header_b64}.{payload_b64}");
    let signature = signing
        .signing_key
        .sign(signing_input.as_bytes())
        .to_bytes();
    let signature_b64 = URL_SAFE_NO_PAD.encode(signature);
    Ok(format!("{signing_input}.{signature_b64}"))
}

pub(crate) fn parse_bearer_token(headers: &HeaderMap) -> Option<String> {
    parse_authorization_token(headers, "Bearer")
}

pub(crate) fn parse_claw_token(headers: &HeaderMap) -> Option<String> {
    parse_authorization_token(headers, "Claw")
}

pub(crate) fn parse_authorization_token(headers: &HeaderMap, prefix: &str) -> Option<String> {
    let raw = headers.get("authorization")?.to_str().ok()?;
    let candidate = raw.trim();
    let expected_prefix = format!("{prefix} ");
    if !candidate.starts_with(&expected_prefix) {
        return None;
    }
    let token = candidate[expected_prefix.len()..].trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

pub(crate) fn parse_agent_did_from_ait(ait: &str) -> Option<String> {
    let payload = decode_jwt_payload(ait)?;
    payload.get("sub")?.as_str().map(|value| value.to_string())
}

pub(crate) fn decode_jwt_payload(token: &str) -> Option<Value> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() < 2 {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD.decode(parts[1]).ok()?;
    serde_json::from_slice::<Value>(&bytes).ok()
}

pub(crate) fn random_b64url(size: usize) -> Option<String> {
    let mut bytes = vec![0_u8; size];
    getrandom_fill(&mut bytes).ok()?;
    Some(URL_SAFE_NO_PAD.encode(bytes))
}

pub(crate) fn make_human_did() -> String {
    format!("did:claw:human:{}", Ulid::new())
}

pub(crate) fn make_agent_did() -> String {
    format!("did:claw:agent:{}", Ulid::new())
}
