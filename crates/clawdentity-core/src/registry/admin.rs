use serde::{Deserialize, Serialize};

use crate::config::{CliConfig, ConfigPathOptions, read_config, resolve_config, write_config};
use crate::error::{CoreError, Result};
use crate::http::blocking_client;

const ADMIN_BOOTSTRAP_PATH: &str = "/v1/admin/bootstrap";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminHuman {
    pub id: String,
    pub did: String,
    pub display_name: String,
    pub role: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminApiKey {
    pub id: String,
    pub name: String,
    pub token: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminInternalService {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminBootstrapResult {
    pub human: AdminHuman,
    pub api_key: AdminApiKey,
    pub internal_service: AdminInternalService,
    pub registry_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdminBootstrapInput {
    pub bootstrap_secret: String,
    pub display_name: Option<String>,
    pub api_key_name: Option<String>,
    pub registry_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdminBootstrapPayload {
    human: AdminHumanPayload,
    api_key: AdminApiKeyPayload,
    internal_service: AdminInternalServicePayload,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdminHumanPayload {
    id: String,
    did: String,
    display_name: String,
    role: String,
    status: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdminApiKeyPayload {
    id: String,
    name: String,
    token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdminInternalServicePayload {
    id: String,
    name: String,
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

fn parse_non_empty(value: &str, field: &str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(CoreError::InvalidInput(format!("{field} is required")));
    }
    Ok(trimmed.to_string())
}

fn normalize_registry_url(value: &str) -> Result<String> {
    url::Url::parse(value.trim())
        .map(|url| url.to_string())
        .map_err(|_| CoreError::InvalidUrl {
            context: "registryUrl",
            value: value.to_string(),
        })
}

fn to_request_url(registry_url: &str) -> Result<String> {
    let base = if registry_url.ends_with('/') {
        registry_url.to_string()
    } else {
        format!("{registry_url}/")
    };
    let joined = url::Url::parse(&base)
        .map_err(|_| CoreError::InvalidUrl {
            context: "registryUrl",
            value: registry_url.to_string(),
        })?
        .join(ADMIN_BOOTSTRAP_PATH.trim_start_matches('/'))
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

fn parse_bootstrap_payload(
    payload: AdminBootstrapPayload,
    registry_url: String,
) -> Result<AdminBootstrapResult> {
    Ok(AdminBootstrapResult {
        human: AdminHuman {
            id: parse_non_empty(&payload.human.id, "human.id")?,
            did: parse_non_empty(&payload.human.did, "human.did")?,
            display_name: parse_non_empty(&payload.human.display_name, "human.displayName")?,
            role: parse_non_empty(&payload.human.role, "human.role")?,
            status: parse_non_empty(&payload.human.status, "human.status")?,
        },
        api_key: AdminApiKey {
            id: parse_non_empty(&payload.api_key.id, "apiKey.id")?,
            name: parse_non_empty(&payload.api_key.name, "apiKey.name")?,
            token: parse_non_empty(&payload.api_key.token, "apiKey.token")?,
        },
        internal_service: AdminInternalService {
            id: parse_non_empty(&payload.internal_service.id, "internalService.id")?,
            name: parse_non_empty(&payload.internal_service.name, "internalService.name")?,
        },
        registry_url,
    })
}

/// TODO(clawdentity): document `bootstrap_admin`.
pub fn bootstrap_admin(
    options: &ConfigPathOptions,
    input: AdminBootstrapInput,
) -> Result<AdminBootstrapResult> {
    let config = resolve_config(options)?;
    let registry_url = normalize_registry_url(
        input
            .registry_url
            .as_deref()
            .unwrap_or(config.registry_url.as_str()),
    )?;
    let bootstrap_secret = parse_non_empty(&input.bootstrap_secret, "bootstrapSecret")?;

    let response = blocking_client()?
        .post(to_request_url(&registry_url)?)
        .header("x-bootstrap-secret", bootstrap_secret)
        .header("content-type", "application/json")
        .json(&serde_json::json!({
            "displayName": input
                .display_name
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty()),
            "apiKeyName": input
                .api_key_name
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
        .json::<AdminBootstrapPayload>()
        .map_err(|error| CoreError::Http(error.to_string()))?;
    parse_bootstrap_payload(payload, registry_url)
}

/// TODO(clawdentity): document `persist_bootstrap_config`.
pub fn persist_bootstrap_config(
    options: &ConfigPathOptions,
    bootstrap: &AdminBootstrapResult,
) -> Result<CliConfig> {
    let mut config = read_config(options)?;
    config.registry_url = normalize_registry_url(&bootstrap.registry_url)?;
    config.api_key = Some(parse_non_empty(&bootstrap.api_key.token, "apiKey.token")?);
    if !bootstrap.human.display_name.trim().is_empty() {
        config.human_name = Some(bootstrap.human.display_name.trim().to_string());
    }
    let _ = write_config(&config, options)?;
    Ok(config)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use tempfile::TempDir;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use crate::config::{CliConfig, ConfigPathOptions, read_config, write_config};

    use super::{AdminBootstrapInput, bootstrap_admin, persist_bootstrap_config};

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
            api_key: None,
            human_name: None,
        };
        let _ = write_config(&config, &options).expect("write config");
    }

    #[tokio::test]
    async fn bootstrap_and_persist_admin_config() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/admin/bootstrap"))
            .and(header("x-bootstrap-secret", "secret"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "human": {
                    "id": "01HF7YAT00W6W7CM7N3W5FDXT4",
                    "did": "did:claw:human:01HF7YAT31JZHSMW1CG6Q6MHB7",
                    "displayName": "Alice",
                    "role": "admin",
                    "status": "active"
                },
                "apiKey": {
                    "id": "01HF7YAT00W6W7CM7N3W5FDXT5",
                    "name": "admin-cli",
                    "token": "pat_admin"
                },
                "internalService": {
                    "id": "01HF7YAT00W6W7CM7N3W5FDXT6",
                    "name": "bootstrap-internal"
                }
            })))
            .mount(&server)
            .await;

        let temp = TempDir::new().expect("temp dir");
        seed_config(temp.path(), &server.uri());
        let options = options(temp.path());

        let bootstrap_options = options.clone();
        let bootstrap = tokio::task::spawn_blocking(move || {
            bootstrap_admin(
                &bootstrap_options,
                AdminBootstrapInput {
                    bootstrap_secret: "secret".to_string(),
                    display_name: Some("Alice".to_string()),
                    api_key_name: Some("admin-cli".to_string()),
                    registry_url: None,
                },
            )
        })
        .await
        .expect("join")
        .expect("bootstrap");
        assert_eq!(bootstrap.api_key.token, "pat_admin");

        let _ = persist_bootstrap_config(&options, &bootstrap).expect("persist");
        let config = read_config(&options).expect("read");
        assert_eq!(config.api_key.as_deref(), Some("pat_admin"));
        assert_eq!(config.human_name.as_deref(), Some("Alice"));
    }
}
