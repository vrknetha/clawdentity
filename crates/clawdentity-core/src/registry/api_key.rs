use serde::{Deserialize, Serialize};

use crate::config::{ConfigPathOptions, resolve_config};
use crate::error::{CoreError, Result};
use crate::http::blocking_client;

const ME_API_KEYS_PATH: &str = "/v1/me/api-keys";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyMetadata {
    pub id: String,
    pub name: String,
    pub status: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyWithToken {
    pub id: String,
    pub name: String,
    pub status: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<String>,
    pub token: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyCreateResult {
    pub api_key: ApiKeyWithToken,
    pub registry_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyListResult {
    pub api_keys: Vec<ApiKeyMetadata>,
    pub registry_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyRevokeResult {
    pub api_key_id: String,
    pub registry_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiKeyCreateInput {
    pub name: Option<String>,
    pub registry_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiKeyListInput {
    pub registry_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiKeyRevokeInput {
    pub id: String,
    pub registry_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiKeyCreateResponse {
    api_key: ApiKeyWithTokenPayload,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiKeyListResponse {
    api_keys: Vec<ApiKeyMetadataPayload>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiKeyWithTokenPayload {
    id: String,
    name: String,
    status: String,
    created_at: String,
    last_used_at: Option<String>,
    token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiKeyMetadataPayload {
    id: String,
    name: String,
    status: String,
    created_at: String,
    last_used_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ErrorEnvelope {
    error: Option<RegistryError>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryError {
    message: Option<String>,
}

#[derive(Debug, Clone)]
struct ApiKeyRuntime {
    registry_url: String,
    api_key: String,
}

fn parse_non_empty(value: &str, field: &str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(CoreError::InvalidInput(format!(
            "{field} in API key response is invalid"
        )));
    }
    Ok(trimmed.to_string())
}

fn parse_api_key_status(status: &str) -> Result<String> {
    let normalized = status.trim();
    if normalized == "active" || normalized == "revoked" {
        return Ok(normalized.to_string());
    }
    Err(CoreError::InvalidInput(
        "status in API key response is invalid".to_string(),
    ))
}

fn normalize_registry_url(value: &str) -> Result<String> {
    url::Url::parse(value.trim())
        .map(|url| url.to_string())
        .map_err(|_| CoreError::InvalidUrl {
            context: "registryUrl",
            value: value.to_string(),
        })
}

fn resolve_runtime(
    options: &ConfigPathOptions,
    override_registry_url: Option<String>,
) -> Result<ApiKeyRuntime> {
    let config = resolve_config(options)?;
    let registry_url = normalize_registry_url(
        override_registry_url
            .as_deref()
            .unwrap_or(config.registry_url.as_str()),
    )?;
    let api_key = config
        .api_key
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            CoreError::InvalidInput(
                "API key is not configured. Use `config set apiKey <token>` first.".to_string(),
            )
        })?;

    Ok(ApiKeyRuntime {
        registry_url,
        api_key,
    })
}

fn to_api_key_request_url(registry_url: &str, api_key_id: Option<&str>) -> Result<String> {
    let base = if registry_url.ends_with('/') {
        registry_url.to_string()
    } else {
        format!("{registry_url}/")
    };
    let path = match api_key_id {
        Some(id) => format!("{}/{}", ME_API_KEYS_PATH.trim_start_matches('/'), id),
        None => ME_API_KEYS_PATH.trim_start_matches('/').to_string(),
    };
    let joined = url::Url::parse(&base)
        .map_err(|_| CoreError::InvalidUrl {
            context: "registryUrl",
            value: registry_url.to_string(),
        })?
        .join(&path)
        .map_err(|_| CoreError::InvalidUrl {
            context: "registryUrl",
            value: registry_url.to_string(),
        })?;
    Ok(joined.to_string())
}

fn parse_error_message(response_body: &str) -> String {
    match serde_json::from_str::<ErrorEnvelope>(response_body) {
        Ok(envelope) => envelope
            .error
            .and_then(|error| error.message)
            .unwrap_or_else(|| response_body.to_string()),
        Err(_) => response_body.to_string(),
    }
}

fn parse_api_key_with_token(payload: ApiKeyWithTokenPayload) -> Result<ApiKeyWithToken> {
    Ok(ApiKeyWithToken {
        id: parse_non_empty(&payload.id, "id")?,
        name: parse_non_empty(&payload.name, "name")?,
        status: parse_api_key_status(&payload.status)?,
        created_at: parse_non_empty(&payload.created_at, "createdAt")?,
        last_used_at: payload
            .last_used_at
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        token: parse_non_empty(&payload.token, "token")?,
    })
}

fn parse_api_key_metadata(payload: ApiKeyMetadataPayload) -> Result<ApiKeyMetadata> {
    Ok(ApiKeyMetadata {
        id: parse_non_empty(&payload.id, "id")?,
        name: parse_non_empty(&payload.name, "name")?,
        status: parse_api_key_status(&payload.status)?,
        created_at: parse_non_empty(&payload.created_at, "createdAt")?,
        last_used_at: payload
            .last_used_at
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
    })
}

fn parse_api_key_id(value: &str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(CoreError::InvalidInput(
            "API key id is required".to_string(),
        ));
    }
    ulid::Ulid::from_string(trimmed)
        .map(|_| trimmed.to_string())
        .map_err(|_| CoreError::InvalidInput("API key id must be a valid ULID".to_string()))
}

pub fn create_api_key(
    options: &ConfigPathOptions,
    input: ApiKeyCreateInput,
) -> Result<ApiKeyCreateResult> {
    let runtime = resolve_runtime(options, input.registry_url)?;
    let response = blocking_client()?
        .post(to_api_key_request_url(&runtime.registry_url, None)?)
        .header("authorization", format!("Bearer {}", runtime.api_key))
        .header("content-type", "application/json")
        .json(&serde_json::json!({
            "name": input
                .name
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty()),
        }))
        .send()
        .map_err(|error| CoreError::Http(error.to_string()))?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let response_body = response.text().unwrap_or_default();
        return Err(CoreError::HttpStatus {
            status,
            message: parse_error_message(&response_body),
        });
    }

    let payload = response
        .json::<ApiKeyCreateResponse>()
        .map_err(|error| CoreError::Http(error.to_string()))?;
    Ok(ApiKeyCreateResult {
        api_key: parse_api_key_with_token(payload.api_key)?,
        registry_url: runtime.registry_url,
    })
}

pub fn list_api_keys(
    options: &ConfigPathOptions,
    input: ApiKeyListInput,
) -> Result<ApiKeyListResult> {
    let runtime = resolve_runtime(options, input.registry_url)?;
    let response = blocking_client()?
        .get(to_api_key_request_url(&runtime.registry_url, None)?)
        .header("authorization", format!("Bearer {}", runtime.api_key))
        .send()
        .map_err(|error| CoreError::Http(error.to_string()))?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let response_body = response.text().unwrap_or_default();
        return Err(CoreError::HttpStatus {
            status,
            message: parse_error_message(&response_body),
        });
    }

    let payload = response
        .json::<ApiKeyListResponse>()
        .map_err(|error| CoreError::Http(error.to_string()))?;
    let api_keys = payload
        .api_keys
        .into_iter()
        .map(parse_api_key_metadata)
        .collect::<Result<Vec<_>>>()?;
    Ok(ApiKeyListResult {
        api_keys,
        registry_url: runtime.registry_url,
    })
}

pub fn revoke_api_key(
    options: &ConfigPathOptions,
    input: ApiKeyRevokeInput,
) -> Result<ApiKeyRevokeResult> {
    let runtime = resolve_runtime(options, input.registry_url)?;
    let api_key_id = parse_api_key_id(&input.id)?;
    let response = blocking_client()?
        .delete(to_api_key_request_url(
            &runtime.registry_url,
            Some(&api_key_id),
        )?)
        .header("authorization", format!("Bearer {}", runtime.api_key))
        .send()
        .map_err(|error| CoreError::Http(error.to_string()))?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let response_body = response.text().unwrap_or_default();
        return Err(CoreError::HttpStatus {
            status,
            message: parse_error_message(&response_body),
        });
    }

    Ok(ApiKeyRevokeResult {
        api_key_id,
        registry_url: runtime.registry_url,
    })
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use tempfile::TempDir;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use crate::config::{CliConfig, ConfigPathOptions, write_config};

    use super::{
        ApiKeyCreateInput, ApiKeyListInput, ApiKeyRevokeInput, create_api_key, list_api_keys,
        revoke_api_key,
    };

    fn options(home: &Path) -> ConfigPathOptions {
        ConfigPathOptions {
            home_dir: Some(home.to_path_buf()),
            registry_url_hint: None,
        }
    }

    fn seed_config(home: &Path, registry_url: &str) {
        let options = options(home);
        let config = CliConfig {
            registry_url: registry_url.to_string(),
            proxy_url: None,
            api_key: Some("pat_local".to_string()),
            human_name: Some("alice".to_string()),
        };
        let _ = write_config(&config, &options).expect("write config");
    }

    #[tokio::test]
    async fn create_list_and_revoke_api_key_round_trip() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/me/api-keys"))
            .and(header("authorization", "Bearer pat_local"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "apiKey": {
                    "id": "01HF7YAT00W6W7CM7N3W5FDXT4",
                    "name": "primary",
                    "status": "active",
                    "createdAt": "2030-01-01T00:00:00.000Z",
                    "lastUsedAt": null,
                    "token": "pat_123"
                }
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/me/api-keys"))
            .and(header("authorization", "Bearer pat_local"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "apiKeys": [{
                    "id": "01HF7YAT00W6W7CM7N3W5FDXT4",
                    "name": "primary",
                    "status": "active",
                    "createdAt": "2030-01-01T00:00:00.000Z",
                    "lastUsedAt": "2030-01-02T00:00:00.000Z"
                }]
            })))
            .mount(&server)
            .await;
        Mock::given(method("DELETE"))
            .and(path("/v1/me/api-keys/01HF7YAT00W6W7CM7N3W5FDXT4"))
            .and(header("authorization", "Bearer pat_local"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;

        let temp = TempDir::new().expect("temp dir");
        seed_config(temp.path(), &server.uri());
        let options = options(temp.path());

        let create_options = options.clone();
        let created = tokio::task::spawn_blocking(move || {
            create_api_key(
                &create_options,
                ApiKeyCreateInput {
                    name: Some("primary".to_string()),
                    registry_url: None,
                },
            )
        })
        .await
        .expect("join")
        .expect("create");
        assert_eq!(created.api_key.token, "pat_123");

        let list_options = options.clone();
        let listed = tokio::task::spawn_blocking(move || {
            list_api_keys(&list_options, ApiKeyListInput { registry_url: None })
        })
        .await
        .expect("join")
        .expect("list");
        assert_eq!(listed.api_keys.len(), 1);
        assert_eq!(
            listed.api_keys[0].last_used_at.as_deref(),
            Some("2030-01-02T00:00:00.000Z")
        );

        let revoke_options = options.clone();
        let revoked = tokio::task::spawn_blocking(move || {
            revoke_api_key(
                &revoke_options,
                ApiKeyRevokeInput {
                    id: "01HF7YAT00W6W7CM7N3W5FDXT4".to_string(),
                    registry_url: None,
                },
            )
        })
        .await
        .expect("join")
        .expect("revoke");
        assert_eq!(revoked.api_key_id, "01HF7YAT00W6W7CM7N3W5FDXT4");
    }

    #[test]
    fn revoke_rejects_invalid_ulid() {
        let temp = TempDir::new().expect("temp dir");
        seed_config(temp.path(), "https://registry.example");
        let options = options(temp.path());
        let error = revoke_api_key(
            &options,
            ApiKeyRevokeInput {
                id: "not-ulid".to_string(),
                registry_url: None,
            },
        )
        .expect_err("invalid id");
        assert!(error.to_string().contains("valid ULID"));
    }
}
