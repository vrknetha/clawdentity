use serde::{Deserialize, Serialize};

use crate::config::{CliConfig, ConfigPathOptions, read_config, resolve_config, write_config};
use crate::error::{CoreError, Result};
use crate::http::blocking_client;

const INVITES_PATH: &str = "/v1/invites";
const INVITES_REDEEM_PATH: &str = "/v1/invites/redeem";
const METADATA_PATH: &str = "/v1/metadata";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteRecord {
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteCreateResult {
    pub invite: InviteRecord,
    pub registry_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteRedeemResult {
    pub api_key_token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key_name: Option<String>,
    pub human_name: String,
    pub proxy_url: String,
    pub registry_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InviteCreateInput {
    pub expires_at: Option<String>,
    pub registry_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InviteRedeemInput {
    pub code: String,
    pub display_name: String,
    pub api_key_name: Option<String>,
    pub registry_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InviteEnvelope {
    invite: Option<InvitePayload>,
    code: Option<String>,
    id: Option<String>,
    created_at: Option<String>,
    expires_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InvitePayload {
    code: String,
    id: Option<String>,
    created_at: Option<String>,
    expires_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InviteRedeemResponse {
    api_key: Option<InviteRedeemApiKey>,
    token: Option<String>,
    human: Option<InviteRedeemHuman>,
    proxy_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InviteRedeemApiKey {
    id: Option<String>,
    name: Option<String>,
    token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InviteRedeemHuman {
    display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryMetadata {
    proxy_url: Option<String>,
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
struct InviteRuntime {
    registry_url: String,
    config: CliConfig,
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

fn normalize_proxy_url(value: &str) -> Result<String> {
    let parsed = url::Url::parse(value.trim()).map_err(|_| {
        CoreError::InvalidInput("invite redeem response proxyUrl is invalid".to_string())
    })?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err(CoreError::InvalidInput(
            "invite redeem response proxyUrl is invalid".to_string(),
        ));
    }
    Ok(parsed.to_string())
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

fn to_request_url(registry_url: &str, path: &str) -> Result<String> {
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
        .join(path.trim_start_matches('/'))
        .map_err(|_| CoreError::InvalidUrl {
            context: "registryUrl",
            value: registry_url.to_string(),
        })?;
    Ok(joined.to_string())
}

fn resolve_runtime(
    options: &ConfigPathOptions,
    override_registry_url: Option<String>,
) -> Result<InviteRuntime> {
    let config = resolve_config(options)?;
    let registry_url = normalize_registry_url(
        override_registry_url
            .as_deref()
            .unwrap_or(config.registry_url.as_str()),
    )?;
    Ok(InviteRuntime {
        registry_url,
        config,
    })
}

fn require_api_key(config: &CliConfig) -> Result<String> {
    config
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| {
            CoreError::InvalidInput(
                "API key is not configured. Use `config set apiKey <token>` first.".to_string(),
            )
        })
}

fn parse_invite_record(envelope: InviteEnvelope) -> Result<InviteRecord> {
    if let Some(invite) = envelope.invite {
        return Ok(InviteRecord {
            code: parse_non_empty(&invite.code, "invite.code")?,
            id: invite
                .id
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
            created_at: invite
                .created_at
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
            expires_at: invite
                .expires_at
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
        });
    }

    Ok(InviteRecord {
        code: parse_non_empty(envelope.code.as_deref().unwrap_or_default(), "invite.code")?,
        id: envelope
            .id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        created_at: envelope
            .created_at
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        expires_at: envelope
            .expires_at
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
    })
}

fn parse_redeem_result(
    registry_url: &str,
    payload: InviteRedeemResponse,
    fallback_proxy_url: Option<String>,
) -> Result<InviteRedeemResult> {
    let token = payload
        .api_key
        .as_ref()
        .and_then(|api_key| api_key.token.as_ref())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            payload
                .token
                .as_ref()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
        .ok_or_else(|| CoreError::InvalidInput("invite redeem response is invalid".to_string()))?;

    let human_name = payload
        .human
        .as_ref()
        .and_then(|human| human.display_name.as_ref())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| CoreError::InvalidInput("invite redeem response is invalid".to_string()))?;

    let proxy_url = payload
        .proxy_url
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or(fallback_proxy_url)
        .ok_or_else(|| CoreError::InvalidInput("invite redeem response is invalid".to_string()))?;

    Ok(InviteRedeemResult {
        api_key_token: token,
        api_key_id: payload
            .api_key
            .as_ref()
            .and_then(|api_key| api_key.id.as_ref())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        api_key_name: payload
            .api_key
            .as_ref()
            .and_then(|api_key| api_key.name.as_ref())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        human_name,
        proxy_url: normalize_proxy_url(&proxy_url)?,
        registry_url: registry_url.to_string(),
    })
}

fn fetch_proxy_url_from_metadata(registry_url: &str) -> Result<Option<String>> {
    let request_url = to_request_url(registry_url, METADATA_PATH)?;
    let client = match blocking_client() {
        Ok(client) => client,
        Err(error) => {
            tracing::warn!(%registry_url, error = %error, "invite metadata client setup failed");
            return Ok(None);
        }
    };
    let response = match client.get(&request_url).send() {
        Ok(response) => response,
        Err(error) => {
            tracing::warn!(%request_url, error = %error, "invite metadata request failed");
            return Ok(None);
        }
    };

    if !response.status().is_success() {
        return Ok(None);
    }

    let payload = match response.json::<RegistryMetadata>() {
        Ok(payload) => payload,
        Err(error) => {
            tracing::warn!(%request_url, error = %error, "invite metadata parse failed");
            return Ok(None);
        }
    };
    Ok(payload
        .proxy_url
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty()))
}

pub fn create_invite(
    options: &ConfigPathOptions,
    input: InviteCreateInput,
) -> Result<InviteCreateResult> {
    let runtime = resolve_runtime(options, input.registry_url)?;
    let api_key = require_api_key(&runtime.config)?;
    let response = blocking_client()?
        .post(to_request_url(&runtime.registry_url, INVITES_PATH)?)
        .header("authorization", format!("Bearer {api_key}"))
        .header("content-type", "application/json")
        .json(&serde_json::json!({
            "expiresAt": input
                .expires_at
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
        .json::<InviteEnvelope>()
        .map_err(|error| CoreError::Http(error.to_string()))?;
    Ok(InviteCreateResult {
        invite: parse_invite_record(payload)?,
        registry_url: runtime.registry_url,
    })
}

pub fn redeem_invite(
    options: &ConfigPathOptions,
    input: InviteRedeemInput,
) -> Result<InviteRedeemResult> {
    let runtime = resolve_runtime(options, input.registry_url)?;
    let invite_code = parse_non_empty(&input.code, "code")?;
    let display_name = parse_non_empty(&input.display_name, "displayName")?;

    let response = blocking_client()?
        .post(to_request_url(&runtime.registry_url, INVITES_REDEEM_PATH)?)
        .header("content-type", "application/json")
        .json(&serde_json::json!({
            "code": invite_code,
            "displayName": display_name,
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
        .json::<InviteRedeemResponse>()
        .map_err(|error| CoreError::Http(error.to_string()))?;
    let fallback_proxy = fetch_proxy_url_from_metadata(&runtime.registry_url)?;
    parse_redeem_result(&runtime.registry_url, payload, fallback_proxy)
}

pub fn persist_redeem_config(
    options: &ConfigPathOptions,
    redeem: &InviteRedeemResult,
) -> Result<CliConfig> {
    let mut config = read_config(options)?;
    config.registry_url = normalize_registry_url(&redeem.registry_url)?;
    config.api_key = Some(parse_non_empty(&redeem.api_key_token, "apiKeyToken")?);
    config.proxy_url = Some(normalize_proxy_url(&redeem.proxy_url)?);
    config.human_name = Some(parse_non_empty(&redeem.human_name, "humanName")?);
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

    use super::{
        InviteCreateInput, InviteRedeemInput, create_invite, persist_redeem_config, redeem_invite,
    };

    fn options(home: &Path) -> ConfigPathOptions {
        ConfigPathOptions {
            home_dir: Some(home.to_path_buf()),
            registry_url_hint: None,
        }
    }

    fn seed_config(home: &Path, registry_url: &str, api_key: Option<&str>) {
        let options = options(home);
        let config = CliConfig {
            registry_url: registry_url.to_string(),
            proxy_url: None,
            api_key: api_key.map(ToOwned::to_owned),
            human_name: None,
        };
        let _ = write_config(&config, &options).expect("write config");
    }

    #[tokio::test]
    async fn create_invite_uses_local_api_key() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/invites"))
            .and(header("authorization", "Bearer pat_local"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "invite": {
                    "code": "invite_123",
                    "id": "01HF7YAT00W6W7CM7N3W5FDXT4",
                    "createdAt": "2030-01-01T00:00:00.000Z",
                    "expiresAt": null
                }
            })))
            .mount(&server)
            .await;

        let temp = TempDir::new().expect("temp dir");
        seed_config(temp.path(), &server.uri(), Some("pat_local"));

        let create_options = options(temp.path());
        let created = tokio::task::spawn_blocking(move || {
            create_invite(
                &create_options,
                InviteCreateInput {
                    expires_at: None,
                    registry_url: None,
                },
            )
        })
        .await
        .expect("join")
        .expect("create invite");
        assert_eq!(created.invite.code, "invite_123");
    }

    #[tokio::test]
    async fn redeem_invite_uses_registry_metadata_proxy_and_persists_config() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/invites/redeem"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "apiKey": {
                    "id": "01HF7YAT00W6W7CM7N3W5FDXT5",
                    "name": "cli-onboard",
                    "token": "pat_onboard"
                },
                "human": {
                    "displayName": "Alice"
                }
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/metadata"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "proxyUrl": "https://proxy.example"
            })))
            .mount(&server)
            .await;

        let temp = TempDir::new().expect("temp dir");
        seed_config(temp.path(), &server.uri(), None);
        let options = options(temp.path());

        let redeem_options = options.clone();
        let redeemed = tokio::task::spawn_blocking(move || {
            redeem_invite(
                &redeem_options,
                InviteRedeemInput {
                    code: "invite_123".to_string(),
                    display_name: "Alice".to_string(),
                    api_key_name: Some("cli-onboard".to_string()),
                    registry_url: None,
                },
            )
        })
        .await
        .expect("join")
        .expect("redeem invite");
        assert_eq!(redeemed.api_key_token, "pat_onboard");
        assert_eq!(redeemed.proxy_url, "https://proxy.example/");

        let _ = persist_redeem_config(&options, &redeemed).expect("persist");
        let config = read_config(&options).expect("config");
        assert_eq!(config.api_key.as_deref(), Some("pat_onboard"));
        assert_eq!(config.human_name.as_deref(), Some("Alice"));
    }
}
