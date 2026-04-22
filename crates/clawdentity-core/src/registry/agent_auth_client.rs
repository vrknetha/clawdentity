use std::fs;
use std::path::Path;

use chrono::Utc;
use reqwest::Method;
use serde::{Deserialize, Serialize};

use crate::config::{ConfigPathOptions, get_config_dir, resolve_config};
use crate::constants::{AGENTS_DIR, AIT_FILE_NAME, SECRET_KEY_FILE_NAME};
use crate::did::{parse_agent_did, parse_human_did};
use crate::error::{CoreError, Result};
use crate::http::client;
use crate::identity::decode_secret_key;
use crate::new_frame_id;
use crate::registry::agent::{AgentAuthRecord, inspect_agent};
use crate::signing::{SignHttpRequestInput, sign_http_request};
use super::agent_name::parse_agent_name;

const REGISTRY_AUTH_FILE_NAME: &str = "registry-auth.json";

#[derive(Debug, Clone)]
pub(crate) struct AgentRegistryAuthRuntime {
    pub(crate) registry_url: String,
    pub(crate) ait: String,
    pub(crate) access_token: String,
    pub(crate) secret_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryAgentProfile {
    pub agent_did: String,
    pub agent_name: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub framework: Option<String>,
    pub status: String,
    pub human_did: String,
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

fn read_required_trimmed_file(path: &Path, label: &str) -> Result<String> {
    let raw = fs::read_to_string(path).map_err(|source| CoreError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    let value = raw.trim();
    if value.is_empty() {
        return Err(CoreError::InvalidInput(format!(
            "{label} is empty at {}",
            path.display()
        )));
    }
    Ok(value.to_string())
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T> {
    let raw = fs::read_to_string(path).map_err(|source| CoreError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    serde_json::from_str::<T>(&raw).map_err(|source| CoreError::JsonParse {
        path: path.to_path_buf(),
        source,
    })
}

pub(crate) fn parse_error_message(response_body: &str) -> String {
    match serde_json::from_str::<ErrorEnvelope>(response_body) {
        Ok(envelope) => envelope
            .error
            .and_then(|error| error.message)
            .unwrap_or_else(|| response_body.to_string()),
        Err(_) => response_body.to_string(),
    }
}

pub(crate) fn join_registry_url(registry_url: &str, path: &str) -> Result<reqwest::Url> {
    let trimmed_registry_url = registry_url.trim();
    let base = if trimmed_registry_url.ends_with('/') {
        trimmed_registry_url.to_string()
    } else {
        format!("{trimmed_registry_url}/")
    };
    let joined = reqwest::Url::parse(&base)
        .map_err(|_| CoreError::InvalidUrl {
            context: "registryUrl",
            value: registry_url.to_string(),
        })?
        .join(path.trim_start_matches('/'))
        .map_err(|_| CoreError::InvalidUrl {
            context: "registryUrl",
            value: registry_url.to_string(),
        })?;
    Ok(joined)
}

fn to_path_with_query(url: &reqwest::Url) -> String {
    match url.query() {
        Some(query) if !query.is_empty() => format!("{}?{query}", url.path()),
        _ => url.path().to_string(),
    }
}

pub(crate) fn load_agent_registry_auth_runtime(
    options: &ConfigPathOptions,
    agent_name: &str,
) -> Result<AgentRegistryAuthRuntime> {
    let normalized_agent_name = parse_agent_name(agent_name)?;
    let config = resolve_config(options)?;
    let config_dir = get_config_dir(options)?;
    let agent_directory = config_dir.join(AGENTS_DIR).join(&normalized_agent_name);

    let _ = inspect_agent(options, &normalized_agent_name)?;

    let ait = read_required_trimmed_file(&agent_directory.join(AIT_FILE_NAME), AIT_FILE_NAME)?;
    let secret_key = read_required_trimmed_file(
        &agent_directory.join(SECRET_KEY_FILE_NAME),
        SECRET_KEY_FILE_NAME,
    )?;
    let auth: AgentAuthRecord = read_json(&agent_directory.join(REGISTRY_AUTH_FILE_NAME))?;
    let access_token = auth.access_token.trim().to_string();
    if access_token.is_empty() {
        return Err(CoreError::InvalidInput(
            "agent access token is empty".to_string(),
        ));
    }

    Ok(AgentRegistryAuthRuntime {
        registry_url: config.registry_url,
        ait,
        access_token,
        secret_key,
    })
}

pub(crate) fn build_signed_headers(
    runtime: &AgentRegistryAuthRuntime,
    method: &str,
    request_url: &reqwest::Url,
    body: &[u8],
) -> Result<Vec<(String, String)>> {
    let signing_key = decode_secret_key(runtime.secret_key.trim())?;
    let timestamp = Utc::now().timestamp().to_string();
    let nonce = new_frame_id();
    let signed = sign_http_request(&SignHttpRequestInput {
        method,
        path_with_query: &to_path_with_query(request_url),
        timestamp: &timestamp,
        nonce: &nonce,
        body,
        secret_key: &signing_key,
    })?;

    let mut headers = Vec::with_capacity(signed.headers.len() + 2);
    headers.push(("authorization".to_string(), format!("Claw {}", runtime.ait)));
    headers.push((
        "x-claw-agent-access".to_string(),
        runtime.access_token.clone(),
    ));
    headers.extend(signed.headers);
    Ok(headers)
}

pub(crate) async fn send_signed_agent_request(
    runtime: &AgentRegistryAuthRuntime,
    method: Method,
    request_url: reqwest::Url,
    body: Option<Vec<u8>>,
) -> Result<reqwest::Response> {
    let body_bytes = body.as_deref().unwrap_or(&[]);
    let headers = build_signed_headers(runtime, method.as_str(), &request_url, body_bytes)?;

    let mut request = client()?.request(method, request_url);
    for (header_name, header_value) in headers {
        request = request.header(header_name, header_value);
    }
    if let Some(bytes) = body {
        request = request
            .header("content-type", "application/json")
            .body(bytes);
    }

    request
        .send()
        .await
        .map_err(|error| CoreError::Http(error.to_string()))
}

fn parse_non_empty(value: &str, field: &str) -> Result<String> {
    let normalized = value.trim();
    if normalized.is_empty() {
        return Err(CoreError::InvalidInput(format!(
            "{field} in agent profile response is invalid"
        )));
    }
    Ok(normalized.to_string())
}

fn profile_field(payload: &serde_json::Value, field: &str) -> Result<String> {
    parse_non_empty(
        payload
            .get(field)
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default(),
        field,
    )
}

fn parse_profile_agent_did(payload: &serde_json::Value) -> Result<String> {
    let agent_did = profile_field(payload, "agentDid")?;
    parse_agent_did(&agent_did)?;
    Ok(agent_did)
}

fn parse_profile_human_did(payload: &serde_json::Value) -> Result<String> {
    let human_did = profile_field(payload, "humanDid")?;
    parse_human_did(&human_did)?;
    Ok(human_did)
}

fn parse_profile_framework(payload: &serde_json::Value) -> Option<String> {
    payload
        .get("framework")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn parse_agent_profile(payload: serde_json::Value) -> Result<RegistryAgentProfile> {
    let agent_did = parse_profile_agent_did(&payload)?;
    let human_did = parse_profile_human_did(&payload)?;

    Ok(RegistryAgentProfile {
        agent_did,
        agent_name: profile_field(&payload, "agentName")?,
        display_name: profile_field(&payload, "displayName")?,
        framework: parse_profile_framework(&payload),
        status: profile_field(&payload, "status")?,
        human_did,
    })
}

/// Fetches a registry profile for the target agent DID using agent-auth.
pub async fn fetch_registry_agent_profile(
    options: &ConfigPathOptions,
    agent_name: &str,
    agent_did: &str,
) -> Result<RegistryAgentProfile> {
    let normalized_agent_did = agent_did.trim().to_string();
    parse_agent_did(&normalized_agent_did)?;
    let runtime = load_agent_registry_auth_runtime(options, agent_name)?;
    let mut request_url = join_registry_url(&runtime.registry_url, "/v1/agents/profile")?;
    request_url
        .query_pairs_mut()
        .append_pair("did", &normalized_agent_did);

    let response = send_signed_agent_request(&runtime, Method::GET, request_url, None).await?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(CoreError::HttpStatus {
            status: 404,
            message: "agent profile not found".to_string(),
        });
    }
    if response.status() == reqwest::StatusCode::UNAUTHORIZED
        || response.status() == reqwest::StatusCode::FORBIDDEN
    {
        return Err(CoreError::HttpStatus {
            status: response.status().as_u16(),
            message: "agent profile lookup is unauthorized".to_string(),
        });
    }
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        return Err(CoreError::HttpStatus {
            status,
            message: parse_error_message(&body),
        });
    }

    let payload = response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| CoreError::Http(error.to_string()))?;
    parse_agent_profile(payload)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use ed25519_dalek::{SigningKey, VerifyingKey};
    use tempfile::tempdir;
    use wiremock::matchers::{header_exists, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use crate::config::{CliConfig, ConfigPathOptions, get_config_dir, write_config};
    use crate::constants::{AGENTS_DIR, AIT_FILE_NAME, SECRET_KEY_FILE_NAME};

    use super::fetch_registry_agent_profile;

    fn fake_ait(agent_did: &str, owner_did: &str, public_key: &str) -> String {
        let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"EdDSA","kid":"test-kid"}"#);
        let payload = URL_SAFE_NO_PAD.encode(format!(
            "{{\"sub\":\"{agent_did}\",\"ownerDid\":\"{owner_did}\",\"framework\":\"generic\",\"cnf\":{{\"jwk\":{{\"x\":\"{public_key}\"}}}},\"exp\":2524608000}}"
        ));
        format!("{header}.{payload}.sig")
    }

    fn seed_agent_state(
        options: &ConfigPathOptions,
        agent_name: &str,
        registry_url: &str,
        access_token: &str,
    ) {
        write_config(
            &CliConfig {
                registry_url: registry_url.to_string(),
                proxy_url: None,
                api_key: None,
                human_name: None,
            },
            options,
        )
        .expect("write config");

        let config_dir = get_config_dir(options).expect("config dir");
        let agent_dir = config_dir.join(AGENTS_DIR).join(agent_name);
        fs::create_dir_all(&agent_dir).expect("agent dir");

        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let verifying_key: VerifyingKey = signing_key.verifying_key();
        let secret_key = URL_SAFE_NO_PAD.encode(signing_key.to_bytes());
        let public_key = URL_SAFE_NO_PAD.encode(verifying_key.as_bytes());
        let agent_did = "did:cdi:127.0.0.1:agent:01HF7YAT31JZHSMW1CG6Q6MHB7";
        let owner_did = "did:cdi:127.0.0.1:human:01HF7YAT31JZHSMW1CG6Q6MHB8";

        fs::write(
            agent_dir.join(AIT_FILE_NAME),
            fake_ait(agent_did, owner_did, &public_key),
        )
        .expect("write ait");
        fs::write(agent_dir.join(SECRET_KEY_FILE_NAME), secret_key).expect("write secret");
        fs::write(
            agent_dir.join("registry-auth.json"),
            format!(
                "{{\"tokenType\":\"Bearer\",\"accessToken\":\"{access_token}\",\"accessExpiresAt\":\"2030-01-01T00:00:00.000Z\",\"refreshToken\":\"refresh-token\",\"refreshExpiresAt\":\"2030-01-02T00:00:00.000Z\"}}"
            ),
        )
        .expect("write auth");
    }

    #[tokio::test]
    async fn fetch_registry_agent_profile_uses_signed_agent_headers() {
        let server = MockServer::start().await;
        let home = tempdir().expect("tempdir");
        let options = ConfigPathOptions {
            home_dir: Some(home.path().to_path_buf()),
            registry_url_hint: Some(server.uri()),
        };
        seed_agent_state(&options, "alpha", &server.uri(), "agent-access-token");

        Mock::given(method("GET"))
            .and(path("/v1/agents/profile"))
            .and(query_param(
                "did",
                "did:cdi:127.0.0.1:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
            ))
            .and(header_exists("authorization"))
            .and(header_exists("x-claw-agent-access"))
            .and(header_exists("x-claw-timestamp"))
            .and(header_exists("x-claw-nonce"))
            .and(header_exists("x-claw-proof"))
            .and(header_exists("x-claw-body-sha256"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "agentDid": "did:cdi:127.0.0.1:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
                "agentName": "alpha",
                "displayName": "Alice",
                "framework": "generic",
                "status": "active",
                "humanDid": "did:cdi:127.0.0.1:human:01HF7YAT31JZHSMW1CG6Q6MHB8"
            })))
            .mount(&server)
            .await;

        let result = fetch_registry_agent_profile(
            &options,
            "alpha",
            "did:cdi:127.0.0.1:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
        )
        .await
        .expect("profile");
        assert_eq!(result.agent_name, "alpha");
        assert_eq!(result.display_name, "Alice");
    }
}
