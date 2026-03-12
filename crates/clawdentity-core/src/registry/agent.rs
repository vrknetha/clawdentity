use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use getrandom::fill as getrandom_fill;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};

use crate::config::{ConfigPathOptions, get_config_dir, resolve_config};
use crate::constants::{AGENTS_DIR, AIT_FILE_NAME, SECRET_KEY_FILE_NAME};
use crate::error::{CoreError, Result};
use crate::http::blocking_client;
use crate::identity::decode_secret_key;
use crate::signing::{SignHttpRequestInput, sign_http_request};

const FILE_MODE: u32 = 0o600;
const IDENTITY_FILE: &str = "identity.json";
const PUBLIC_KEY_FILE: &str = "public.key";
const REGISTRY_AUTH_FILE: &str = "registry-auth.json";

const AGENT_REGISTRATION_CHALLENGE_PATH: &str = "/v1/agents/challenge";
const AGENT_REGISTRATION_PATH: &str = "/v1/agents";
const AGENT_AUTH_REFRESH_PATH: &str = "/v1/agents/auth/refresh";
const AGENT_REGISTRATION_PROOF_VERSION: &str = "clawdentity.register.v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentIdentityRecord {
    pub did: String,
    pub name: String,
    pub framework: String,
    pub expires_at: String,
    pub registry_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAuthRecord {
    pub token_type: String,
    pub access_token: String,
    pub access_expires_at: String,
    pub refresh_token: String,
    pub refresh_expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCreateResult {
    pub name: String,
    pub did: String,
    pub expires_at: String,
    pub framework: String,
    pub registry_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInspectResult {
    pub did: String,
    pub owner_did: String,
    pub expires_at: String,
    pub key_id: String,
    pub public_key: String,
    pub framework: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAuthRefreshResult {
    pub name: String,
    pub status: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAuthRevokeResult {
    pub name: String,
    pub status: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateAgentInput {
    pub name: String,
    pub framework: Option<String>,
    pub ttl_days: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentRegistrationChallengeResponse {
    challenge_id: String,
    nonce: String,
    owner_did: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentRegistrationResponse {
    agent: RegisteredAgentPayload,
    ait: String,
    agent_auth: AgentAuthRecord,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisteredAgentPayload {
    did: String,
    name: String,
    framework: String,
    expires_at: String,
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

fn set_secure_permissions(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = fs::Permissions::from_mode(FILE_MODE);
        fs::set_permissions(path, perms).map_err(|source| CoreError::Io {
            path: path.to_path_buf(),
            source,
        })?;
    }
    Ok(())
}

fn write_secure_text(path: &Path, contents: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|source| CoreError::Io {
            path: parent.to_path_buf(),
            source,
        })?;
    }
    fs::write(path, contents).map_err(|source| CoreError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    set_secure_permissions(path)?;
    Ok(())
}

fn write_secure_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let body = serde_json::to_string_pretty(value)?;
    write_secure_text(path, &format!("{body}\n"))
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

fn parse_agent_name(name: &str) -> Result<String> {
    let candidate = name.trim();
    if candidate.is_empty() {
        return Err(CoreError::InvalidInput(
            "agent name is required".to_string(),
        ));
    }
    if candidate == "." || candidate == ".." {
        return Err(CoreError::InvalidInput(
            "agent name must not be . or ..".to_string(),
        ));
    }
    if candidate.len() > 64 {
        return Err(CoreError::InvalidInput(
            "agent name must be <= 64 characters".to_string(),
        ));
    }
    let valid = candidate
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.');
    if !valid {
        return Err(CoreError::InvalidInput(
            "agent name contains invalid characters".to_string(),
        ));
    }
    Ok(candidate.to_string())
}

fn parse_optional_framework(value: Option<String>) -> Result<Option<String>> {
    let Some(raw) = value else {
        return Ok(None);
    };
    let normalized = raw.trim();
    if normalized.is_empty() {
        return Err(CoreError::InvalidInput(
            "framework cannot be empty when provided".to_string(),
        ));
    }
    Ok(Some(normalized.to_string()))
}

fn parse_optional_ttl_days(value: Option<u32>) -> Result<Option<u32>> {
    match value {
        Some(0) => Err(CoreError::InvalidInput(
            "ttlDays must be a positive integer".to_string(),
        )),
        Some(days) => Ok(Some(days)),
        None => Ok(None),
    }
}

fn agents_dir(options: &ConfigPathOptions) -> Result<PathBuf> {
    Ok(get_config_dir(options)?.join(AGENTS_DIR))
}

fn agent_dir(options: &ConfigPathOptions, name: &str) -> Result<PathBuf> {
    Ok(agents_dir(options)?.join(name))
}

fn now_unix_seconds() -> Result<u64> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| CoreError::InvalidInput(error.to_string()))?
        .as_secs())
}

fn unix_seconds_to_iso(seconds: u64) -> Result<String> {
    let dt = UNIX_EPOCH
        .checked_add(Duration::from_secs(seconds))
        .ok_or_else(|| CoreError::InvalidInput("invalid timestamp".to_string()))?;
    let datetime: chrono::DateTime<chrono::Utc> = dt.into();
    Ok(datetime.to_rfc3339())
}

fn decode_jwt_payload(token: &str) -> Result<serde_json::Value> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() < 2 {
        return Err(CoreError::InvalidInput("invalid AIT token".to_string()));
    }
    let payload = URL_SAFE_NO_PAD
        .decode(parts[1])
        .map_err(|error| CoreError::Base64Decode(error.to_string()))?;
    serde_json::from_slice(&payload).map_err(|error| CoreError::InvalidInput(error.to_string()))
}

fn decode_jwt_header(token: &str) -> Result<serde_json::Value> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.is_empty() {
        return Err(CoreError::InvalidInput("invalid AIT token".to_string()));
    }
    let header = URL_SAFE_NO_PAD
        .decode(parts[0])
        .map_err(|error| CoreError::Base64Decode(error.to_string()))?;
    serde_json::from_slice(&header).map_err(|error| CoreError::InvalidInput(error.to_string()))
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

fn parse_error_message(response_body: &str) -> String {
    match serde_json::from_str::<ErrorEnvelope>(response_body) {
        Ok(envelope) => envelope
            .error
            .and_then(|error| error.message)
            .unwrap_or_else(|| response_body.to_string()),
        Err(_) => response_body.to_string(),
    }
}

fn canonicalize_agent_registration_proof(input: &CanonicalProofInput<'_>) -> String {
    [
        AGENT_REGISTRATION_PROOF_VERSION.to_string(),
        format!("challengeId:{}", input.challenge_id),
        format!("nonce:{}", input.nonce),
        format!("ownerDid:{}", input.owner_did),
        format!("publicKey:{}", input.public_key),
        format!("name:{}", input.name),
        format!("framework:{}", input.framework.unwrap_or("")),
        format!(
            "ttlDays:{}",
            input
                .ttl_days
                .map(|value| value.to_string())
                .unwrap_or_default()
        ),
    ]
    .join("\n")
}

struct CanonicalProofInput<'a> {
    challenge_id: &'a str,
    nonce: &'a str,
    owner_did: &'a str,
    public_key: &'a str,
    name: &'a str,
    framework: Option<&'a str>,
    ttl_days: Option<u32>,
}

struct AgentRegistrationRequest<'a> {
    name: &'a str,
    public_key: &'a str,
    challenge_id: &'a str,
    challenge_signature: &'a str,
    framework: Option<&'a str>,
    ttl_days: Option<u32>,
}

fn request_registration_challenge(
    client: &reqwest::blocking::Client,
    registry_url: &str,
    api_key: &str,
    public_key: &str,
) -> Result<AgentRegistrationChallengeResponse> {
    let url = join_url(registry_url, AGENT_REGISTRATION_CHALLENGE_PATH)?;
    let response = client
        .post(url)
        .header(AUTHORIZATION, format!("Bearer {api_key}"))
        .header(CONTENT_TYPE, "application/json")
        .json(&serde_json::json!({
            "publicKey": public_key,
        }))
        .send()
        .map_err(|error| CoreError::Http(error.to_string()))?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let response_body = response.text().unwrap_or_default();
        let message = parse_error_message(&response_body);
        return Err(CoreError::HttpStatus { status, message });
    }

    response
        .json::<AgentRegistrationChallengeResponse>()
        .map_err(|error| CoreError::Http(error.to_string()))
}

fn request_agent_registration(
    client: &reqwest::blocking::Client,
    registry_url: &str,
    api_key: &str,
    input: AgentRegistrationRequest<'_>,
) -> Result<AgentRegistrationResponse> {
    let mut request_body = serde_json::json!({
        "name": input.name,
        "publicKey": input.public_key,
        "challengeId": input.challenge_id,
        "challengeSignature": input.challenge_signature,
    });
    if let Some(value) = input.framework {
        request_body["framework"] = serde_json::Value::String(value.to_string());
    }
    if let Some(value) = input.ttl_days {
        request_body["ttlDays"] = serde_json::Value::Number(value.into());
    }

    let url = join_url(registry_url, AGENT_REGISTRATION_PATH)?;
    let response = client
        .post(url)
        .header(AUTHORIZATION, format!("Bearer {api_key}"))
        .header(CONTENT_TYPE, "application/json")
        .json(&request_body)
        .send()
        .map_err(|error| CoreError::Http(error.to_string()))?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let response_body = response.text().unwrap_or_default();
        let message = parse_error_message(&response_body);
        return Err(CoreError::HttpStatus { status, message });
    }

    response
        .json::<AgentRegistrationResponse>()
        .map_err(|error| CoreError::Http(error.to_string()))
}

fn random_nonce_base64url(size: usize) -> Result<String> {
    let mut nonce = vec![0_u8; size];
    getrandom_fill(&mut nonce).map_err(|error| CoreError::InvalidInput(error.to_string()))?;
    Ok(URL_SAFE_NO_PAD.encode(nonce))
}

fn path_with_query(request_url: &str) -> Result<String> {
    let parsed = url::Url::parse(request_url).map_err(|_| CoreError::InvalidUrl {
        context: "registryUrl",
        value: request_url.to_string(),
    })?;
    Ok(match parsed.query() {
        Some(query) => format!("{}?{query}", parsed.path()),
        None => parsed.path().to_string(),
    })
}

fn parse_agent_auth_response(payload: serde_json::Value) -> Result<AgentAuthRecord> {
    let source = payload.get("agentAuth").cloned().unwrap_or(payload);
    let parsed = serde_json::from_value::<AgentAuthRecord>(source)
        .map_err(|error| CoreError::InvalidInput(error.to_string()))?;
    if parsed.token_type != "Bearer" {
        return Err(CoreError::InvalidInput(
            "invalid tokenType in agentAuth response".to_string(),
        ));
    }
    Ok(parsed)
}

/// TODO(clawdentity): document `create_agent`.
#[allow(clippy::too_many_lines)]
pub fn create_agent(
    options: &ConfigPathOptions,
    input: CreateAgentInput,
) -> Result<AgentCreateResult> {
    let config = resolve_config(options)?;
    let api_key = config.api_key.ok_or_else(|| {
        CoreError::InvalidInput(
            "API key is not configured. Run `clawdentity config set apiKey <token>` first."
                .to_string(),
        )
    })?;

    let name = parse_agent_name(&input.name)?;
    let framework = parse_optional_framework(input.framework)?;
    let ttl_days = parse_optional_ttl_days(input.ttl_days)?;

    let state_options = options.with_registry_hint(config.registry_url.clone());
    let agent_directory = agent_dir(&state_options, &name)?;
    if agent_directory.exists() {
        return Err(CoreError::IdentityAlreadyExists(agent_directory));
    }
    fs::create_dir_all(&agent_directory).map_err(|source| CoreError::Io {
        path: agent_directory.clone(),
        source,
    })?;

    let mut secret_bytes = [0_u8; 32];
    getrandom_fill(&mut secret_bytes)
        .map_err(|error| CoreError::InvalidInput(error.to_string()))?;
    let signing_key = SigningKey::from_bytes(&secret_bytes);
    let verifying_key: VerifyingKey = signing_key.verifying_key();

    let public_key = URL_SAFE_NO_PAD.encode(verifying_key.as_bytes());
    let secret_key = URL_SAFE_NO_PAD.encode(signing_key.to_bytes());

    let client = blocking_client()?;
    let challenge =
        request_registration_challenge(&client, &config.registry_url, &api_key, &public_key)?;
    let canonical_proof = canonicalize_agent_registration_proof(&CanonicalProofInput {
        challenge_id: &challenge.challenge_id,
        nonce: &challenge.nonce,
        owner_did: &challenge.owner_did,
        public_key: &public_key,
        name: &name,
        framework: framework.as_deref(),
        ttl_days,
    });
    let challenge_signature =
        URL_SAFE_NO_PAD.encode(signing_key.sign(canonical_proof.as_bytes()).to_bytes());

    let registration = request_agent_registration(
        &client,
        &config.registry_url,
        &api_key,
        AgentRegistrationRequest {
            name: &name,
            public_key: &public_key,
            challenge_id: &challenge.challenge_id,
            challenge_signature: &challenge_signature,
            framework: framework.as_deref(),
            ttl_days,
        },
    )?;

    let identity = AgentIdentityRecord {
        did: registration.agent.did.clone(),
        name: registration.agent.name.clone(),
        framework: registration.agent.framework.clone(),
        expires_at: registration.agent.expires_at.clone(),
        registry_url: config.registry_url.clone(),
    };

    write_secure_json(&agent_directory.join(IDENTITY_FILE), &identity)?;
    write_secure_text(
        &agent_directory.join(AIT_FILE_NAME),
        registration.ait.trim(),
    )?;
    write_secure_text(&agent_directory.join(SECRET_KEY_FILE_NAME), &secret_key)?;
    write_secure_text(&agent_directory.join(PUBLIC_KEY_FILE), &public_key)?;
    write_secure_json(
        &agent_directory.join(REGISTRY_AUTH_FILE),
        &registration.agent_auth,
    )?;

    Ok(AgentCreateResult {
        name: registration.agent.name,
        did: registration.agent.did,
        expires_at: registration.agent.expires_at,
        framework: registration.agent.framework,
        registry_url: config.registry_url,
    })
}

/// TODO(clawdentity): document `inspect_agent`.
#[allow(clippy::too_many_lines)]
pub fn inspect_agent(options: &ConfigPathOptions, name: &str) -> Result<AgentInspectResult> {
    let name = parse_agent_name(name)?;
    let agent_directory = agent_dir(options, &name)?;
    let ait_path = agent_directory.join(AIT_FILE_NAME);
    let raw = fs::read_to_string(&ait_path).map_err(|source| CoreError::Io {
        path: ait_path.clone(),
        source,
    })?;
    let token = raw.trim();
    let header = decode_jwt_header(token)?;
    let payload = decode_jwt_payload(token)?;

    let did = payload
        .get("sub")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    let owner_did = payload
        .get("ownerDid")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    let framework = payload
        .get("framework")
        .and_then(|value| value.as_str())
        .unwrap_or("openclaw")
        .to_string();
    let public_key = payload
        .get("cnf")
        .and_then(|value| value.get("jwk"))
        .and_then(|value| value.get("x"))
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    let key_id = header
        .get("kid")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    let exp = payload
        .get("exp")
        .and_then(|value| value.as_u64())
        .unwrap_or_default();
    let expires_at = unix_seconds_to_iso(exp)?;

    if did.is_empty() || owner_did.is_empty() || key_id.is_empty() || public_key.is_empty() {
        return Err(CoreError::InvalidInput(
            "agent AIT payload is invalid".to_string(),
        ));
    }

    Ok(AgentInspectResult {
        did,
        owner_did,
        expires_at,
        key_id,
        public_key,
        framework,
    })
}

/// TODO(clawdentity): document `refresh_agent_auth`.
#[allow(clippy::too_many_lines)]
pub fn refresh_agent_auth(
    options: &ConfigPathOptions,
    name: &str,
) -> Result<AgentAuthRefreshResult> {
    let name = parse_agent_name(name)?;
    let agent_directory = agent_dir(options, &name)?;

    let auth_path = agent_directory.join(REGISTRY_AUTH_FILE);
    let current_auth: AgentAuthRecord = read_json(&auth_path)?;

    let identity_path = agent_directory.join(IDENTITY_FILE);
    let identity: AgentIdentityRecord = read_json(&identity_path)?;
    if identity.registry_url.trim().is_empty() {
        return Err(CoreError::InvalidInput(
            "agent identity is missing registryUrl".to_string(),
        ));
    }

    let ait_path = agent_directory.join(AIT_FILE_NAME);
    let ait_raw = fs::read_to_string(&ait_path).map_err(|source| CoreError::Io {
        path: ait_path.clone(),
        source,
    })?;
    let ait = ait_raw.trim();
    if ait.is_empty() {
        return Err(CoreError::InvalidInput(
            "agent AIT token is empty".to_string(),
        ));
    }

    let secret_path = agent_directory.join(SECRET_KEY_FILE_NAME);
    let secret_raw = fs::read_to_string(&secret_path).map_err(|source| CoreError::Io {
        path: secret_path.clone(),
        source,
    })?;
    let signing_key = decode_secret_key(secret_raw.trim())?;

    let request_body = serde_json::json!({
        "refreshToken": current_auth.refresh_token,
    });
    let request_body_bytes = serde_json::to_vec(&request_body)?;
    let refresh_url = join_url(&identity.registry_url, AGENT_AUTH_REFRESH_PATH)?;
    let path_with_query = path_with_query(&refresh_url)?;
    let timestamp = now_unix_seconds()?.to_string();
    let nonce = random_nonce_base64url(16)?;
    let signed = sign_http_request(&SignHttpRequestInput {
        method: "POST",
        path_with_query: &path_with_query,
        timestamp: &timestamp,
        nonce: &nonce,
        body: &request_body_bytes,
        secret_key: &signing_key,
    })?;

    let mut request = blocking_client()?
        .post(refresh_url)
        .header(AUTHORIZATION, format!("Claw {ait}"))
        .header(CONTENT_TYPE, "application/json");
    for (header_name, value) in signed.headers {
        request = request.header(&header_name, value);
    }

    let response = request
        .body(request_body_bytes)
        .send()
        .map_err(|error| CoreError::Http(error.to_string()))?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let response_body = response.text().unwrap_or_default();
        let message = parse_error_message(&response_body);
        return Err(CoreError::HttpStatus { status, message });
    }

    let payload = response
        .json::<serde_json::Value>()
        .map_err(|error| CoreError::Http(error.to_string()))?;
    let refreshed = parse_agent_auth_response(payload)?;
    write_secure_json(&auth_path, &refreshed)?;

    Ok(AgentAuthRefreshResult {
        name,
        status: "refreshed".to_string(),
        message: "agent auth bundle updated".to_string(),
    })
}

/// TODO(clawdentity): document `revoke_agent_auth`.
pub fn revoke_agent_auth(options: &ConfigPathOptions, name: &str) -> Result<AgentAuthRevokeResult> {
    let name = parse_agent_name(name)?;
    let agent_directory = agent_dir(options, &name)?;
    let auth_path = agent_directory.join(REGISTRY_AUTH_FILE);
    let _: AgentAuthRecord = read_json(&auth_path)?;

    Ok(AgentAuthRevokeResult {
        name,
        status: "not_supported".to_string(),
        message: "not yet supported by registry".to_string(),
    })
}

#[cfg(test)]
#[path = "agent_tests.rs"]
mod tests;
