use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::SigningKey;
use getrandom::fill as getrandom_fill;

use crate::error::{CoreError, Result};
use crate::signing::{SignHttpRequestInput, sign_http_request};

#[derive(Debug, Clone)]
pub struct RelayConnectHeaders {
    pub authorization: String,
    pub signed_headers: Vec<(String, String)>,
}

pub fn build_relay_connect_headers(
    relay_connect_url: &str,
    ait: &str,
    secret_key: &SigningKey,
) -> Result<RelayConnectHeaders> {
    let trimmed_ait = ait.trim();
    if trimmed_ait.is_empty() {
        return Err(CoreError::InvalidInput("AIT token is required".to_string()));
    }

    let parsed = url::Url::parse(relay_connect_url).map_err(|_| CoreError::InvalidUrl {
        context: "relayConnectUrl",
        value: relay_connect_url.to_string(),
    })?;
    let path_with_query = match parsed.query() {
        Some(query) => format!("{}?{query}", parsed.path()),
        None => parsed.path().to_string(),
    };

    let mut nonce_bytes = [0_u8; 16];
    getrandom_fill(&mut nonce_bytes).map_err(|error| CoreError::InvalidInput(error.to_string()))?;
    let nonce = URL_SAFE_NO_PAD.encode(nonce_bytes);
    let timestamp = format!("{}", chrono::Utc::now().timestamp());
    let signed = sign_http_request(&SignHttpRequestInput {
        method: "GET",
        path_with_query: &path_with_query,
        timestamp: &timestamp,
        nonce: &nonce,
        body: &[],
        secret_key,
    })?;

    Ok(RelayConnectHeaders {
        authorization: format!("Claw {trimmed_ait}"),
        signed_headers: signed.headers,
    })
}

#[cfg(test)]
mod tests {
    use ed25519_dalek::SigningKey;

    use super::build_relay_connect_headers;

    #[test]
    fn build_relay_headers_includes_authorization_and_claw_proof_headers() {
        let key = SigningKey::from_bytes(&[7_u8; 32]);
        let headers = build_relay_connect_headers(
            "wss://proxy.clawdentity.com/v1/relay/connect",
            "ait.jwt.value",
            &key,
        )
        .expect("headers");
        assert_eq!(headers.authorization, "Claw ait.jwt.value");
        assert_eq!(headers.signed_headers.len(), 4);
    }
}
