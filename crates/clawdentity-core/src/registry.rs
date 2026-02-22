use serde::{Deserialize, Serialize};

use crate::error::{CoreError, Result};
use crate::identity::LocalIdentity;

const REGISTRY_METADATA_PATH: &str = "/v1/metadata";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryMetadata {
    pub registry_url: String,
    pub proxy_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterIdentityResult {
    pub registry_url: String,
    pub status: String,
    pub message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MetadataPayload {
    registry_url: Option<String>,
    proxy_url: Option<String>,
}

fn join_url(base: &str, path: &str) -> Result<String> {
    let base_url = url::Url::parse(base).map_err(|_| CoreError::InvalidUrl {
        context: "registryUrl",
        value: base.to_string(),
    })?;
    let joined = base_url.join(path).map_err(|_| CoreError::InvalidUrl {
        context: "registryUrl",
        value: base.to_string(),
    })?;
    Ok(joined.to_string())
}

pub async fn fetch_registry_metadata(
    client: &reqwest::Client,
    registry_url: &str,
) -> Result<RegistryMetadata> {
    let url = join_url(registry_url, REGISTRY_METADATA_PATH)?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| CoreError::Http(error.to_string()))?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let message = response
            .text()
            .await
            .unwrap_or_else(|_| "metadata request failed".to_string());
        return Err(CoreError::HttpStatus { status, message });
    }

    let payload = response
        .json::<MetadataPayload>()
        .await
        .map_err(|error| CoreError::Http(error.to_string()))?;

    Ok(RegistryMetadata {
        registry_url: payload
            .registry_url
            .unwrap_or_else(|| registry_url.to_string()),
        proxy_url: payload.proxy_url.unwrap_or_default(),
    })
}

pub async fn register_identity(
    _client: &reqwest::Client,
    registry_url: &str,
    _identity: &LocalIdentity,
) -> Result<RegisterIdentityResult> {
    Ok(RegisterIdentityResult {
        registry_url: registry_url.to_string(),
        status: "not_supported".to_string(),
        message: "Identity registration is challenge-based via `agent create`.".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use crate::identity::LocalIdentity;

    use super::{fetch_registry_metadata, register_identity};

    #[tokio::test]
    async fn fetch_registry_metadata_parses_registry_and_proxy_urls() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/metadata"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "registryUrl": server.uri(),
                "proxyUrl": format!("{}/proxy", server.uri()),
            })))
            .mount(&server)
            .await;

        let client = crate::http::client().expect("client");
        let metadata = fetch_registry_metadata(&client, &server.uri())
            .await
            .expect("metadata");
        assert_eq!(metadata.registry_url, server.uri());
        assert_eq!(metadata.proxy_url, format!("{}/proxy", server.uri()));
    }

    #[tokio::test]
    async fn register_identity_returns_not_supported_for_legacy_flow() {
        let client = crate::http::client().expect("client");
        let identity = LocalIdentity {
            did: "did:claw:human:01ARZ3NDEKTSV4RRFFQ69G5FAV".to_string(),
            public_key: "abc".to_string(),
            secret_key: "def".to_string(),
            registry_url: "https://registry.clawdentity.com".to_string(),
        };

        let result = register_identity(&client, "https://registry.clawdentity.com", &identity)
            .await
            .expect("register");
        assert_eq!(result.status, "not_supported");
    }
}
