use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signer, SigningKey};
use sha2::{Digest, Sha256};

use crate::error::{CoreError, Result};

pub const CANONICAL_REQUEST_VERSION: &str = "CLAW-PROOF-V1";
pub const X_CLAW_TIMESTAMP: &str = "X-Claw-Timestamp";
pub const X_CLAW_NONCE: &str = "X-Claw-Nonce";
pub const X_CLAW_BODY_SHA256: &str = "X-Claw-Body-SHA256";
pub const X_CLAW_PROOF: &str = "X-Claw-Proof";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignHttpRequestInput<'a> {
    pub method: &'a str,
    pub path_with_query: &'a str,
    pub timestamp: &'a str,
    pub nonce: &'a str,
    pub body: &'a [u8],
    pub secret_key: &'a SigningKey,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedRequest {
    pub canonical_request: String,
    pub proof: String,
    pub body_hash: String,
    pub headers: Vec<(String, String)>,
}

pub fn canonicalize_request(input: &SignHttpRequestInput<'_>, body_hash: &str) -> String {
    [
        CANONICAL_REQUEST_VERSION,
        &input.method.to_uppercase(),
        input.path_with_query,
        input.timestamp,
        input.nonce,
        body_hash,
    ]
    .join("\n")
}

pub fn hash_body_sha256_base64url(body: &[u8]) -> String {
    let digest = Sha256::digest(body);
    URL_SAFE_NO_PAD.encode(digest)
}

pub fn sign_http_request(input: &SignHttpRequestInput<'_>) -> Result<SignedRequest> {
    if input.method.trim().is_empty() {
        return Err(CoreError::InvalidInput("method is required".to_string()));
    }
    if input.path_with_query.trim().is_empty() {
        return Err(CoreError::InvalidInput(
            "pathWithQuery is required".to_string(),
        ));
    }
    if input.timestamp.trim().is_empty() {
        return Err(CoreError::InvalidInput("timestamp is required".to_string()));
    }
    if input.nonce.trim().is_empty() {
        return Err(CoreError::InvalidInput("nonce is required".to_string()));
    }

    let body_hash = hash_body_sha256_base64url(input.body);
    let canonical_request = canonicalize_request(input, &body_hash);
    let signature = input.secret_key.sign(canonical_request.as_bytes());
    let proof = URL_SAFE_NO_PAD.encode(signature.to_bytes());

    Ok(SignedRequest {
        canonical_request,
        proof: proof.clone(),
        body_hash: body_hash.clone(),
        headers: vec![
            (X_CLAW_TIMESTAMP.to_string(), input.timestamp.to_string()),
            (X_CLAW_NONCE.to_string(), input.nonce.to_string()),
            (X_CLAW_BODY_SHA256.to_string(), body_hash),
            (X_CLAW_PROOF.to_string(), proof),
        ],
    })
}

#[cfg(test)]
mod tests {
    use ed25519_dalek::SigningKey;

    use super::{SignHttpRequestInput, canonicalize_request, sign_http_request};

    #[test]
    fn canonical_request_uses_expected_format() {
        let key = SigningKey::from_bytes(&[42_u8; 32]);
        let input = SignHttpRequestInput {
            method: "post",
            path_with_query: "/pair/start?x=1",
            timestamp: "1700000000",
            nonce: "abc",
            body: br#"{"hello":"world"}"#,
            secret_key: &key,
        };
        let signed = sign_http_request(&input).expect("sign");
        let canonical = canonicalize_request(&input, &signed.body_hash);
        assert_eq!(signed.canonical_request, canonical);
        assert!(signed.proof.len() > 10);
        assert_eq!(signed.headers.len(), 4);
    }
}
