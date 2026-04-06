use reqwest::Method;
use serde::{Deserialize, Serialize};

use crate::config::ConfigPathOptions;
use crate::did::{parse_agent_did, parse_group_id};
use crate::error::{CoreError, Result};

use super::agent_auth_client::{
    join_registry_url, load_agent_registry_auth_runtime, parse_error_message,
    send_signed_agent_request,
};

const GROUPS_PATH: &str = "/v1/groups";
const GROUP_JOIN_PATH: &str = "/v1/groups/join";
const GROUP_JOIN_TOKEN_MARKER: &str = "clw_gjt_";
const GROUP_NAME_MAX_LENGTH: usize = 80;
const GROUP_JOIN_TOKEN_TTL_MIN_SECONDS: u32 = 60;
const GROUP_JOIN_TOKEN_TTL_MAX_SECONDS: u32 = 30 * 24 * 60 * 60;
const GROUP_JOIN_TOKEN_MAX_USES_MIN: u32 = 1;
const GROUP_JOIN_TOKEN_MAX_USES_MAX: u32 = 25;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GroupRole {
    Member,
    Admin,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupRecord {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupCreateResult {
    pub group: GroupRecord,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupInspectResult {
    pub group: GroupRecord,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupJoinTokenRecord {
    pub id: String,
    pub token: String,
    pub group_id: String,
    pub role: GroupRole,
    pub max_uses: u32,
    pub expires_at: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupJoinTokenCreateResult {
    pub group_join_token: GroupJoinTokenRecord,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupJoinResult {
    pub joined: bool,
    pub group_id: String,
    pub agent_did: String,
    pub role: GroupRole,
    pub joined_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupMembersListGroup {
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupMemberRecord {
    pub agent_did: String,
    pub role: GroupRole,
    pub joined_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupMembersListResult {
    pub group: GroupMembersListGroup,
    pub members: Vec<GroupMemberRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupCreateInput {
    pub agent_name: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupInspectInput {
    pub agent_name: String,
    pub group_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupJoinTokenCreateInput {
    pub agent_name: String,
    pub group_id: String,
    pub expires_in_seconds: Option<u32>,
    pub max_uses: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupJoinInput {
    pub agent_name: String,
    pub group_join_token: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupMembersListInput {
    pub agent_name: String,
    pub group_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GroupCreateResponsePayload {
    group: GroupPayload,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GroupInspectResponsePayload {
    group: GroupPayload,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GroupPayload {
    id: String,
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GroupJoinTokenCreateResponsePayload {
    group_join_token: GroupJoinTokenPayload,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GroupJoinTokenPayload {
    id: String,
    token: String,
    group_id: String,
    role: GroupRole,
    max_uses: u32,
    expires_at: String,
    created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GroupJoinResponsePayload {
    joined: bool,
    group_id: String,
    agent_did: String,
    role: GroupRole,
    joined_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GroupMembersListResponsePayload {
    group: GroupMembersListGroupPayload,
    members: Vec<GroupMemberPayload>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GroupMembersListGroupPayload {
    id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GroupMemberPayload {
    agent_did: String,
    role: GroupRole,
    joined_at: String,
}

fn parse_non_empty(value: &str, field: &str) -> Result<String> {
    let normalized = value.trim();
    if normalized.is_empty() {
        return Err(CoreError::InvalidInput(format!("{field} is invalid")));
    }
    Ok(normalized.to_string())
}

fn has_control_chars(value: &str) -> bool {
    value.chars().any(|ch| ch.is_control())
}

fn parse_group_name(name: &str) -> Result<String> {
    let normalized = name.trim();
    if normalized.is_empty() {
        return Err(CoreError::InvalidInput(
            "group name is required".to_string(),
        ));
    }
    if normalized.chars().count() > GROUP_NAME_MAX_LENGTH {
        return Err(CoreError::InvalidInput(format!(
            "group name must be at most {GROUP_NAME_MAX_LENGTH} characters"
        )));
    }
    if has_control_chars(normalized) {
        return Err(CoreError::InvalidInput(
            "group name contains control characters".to_string(),
        ));
    }
    Ok(normalized.to_string())
}

fn parse_group_join_token(token: &str) -> Result<String> {
    let normalized = token.trim();
    if !normalized.starts_with(GROUP_JOIN_TOKEN_MARKER)
        || normalized.len() <= GROUP_JOIN_TOKEN_MARKER.len()
    {
        return Err(CoreError::InvalidInput(
            "groupJoinToken is invalid".to_string(),
        ));
    }
    Ok(normalized.to_string())
}

fn parse_optional_expires_in_seconds(value: Option<u32>) -> Result<Option<u32>> {
    let Some(seconds) = value else {
        return Ok(None);
    };
    if !(GROUP_JOIN_TOKEN_TTL_MIN_SECONDS..=GROUP_JOIN_TOKEN_TTL_MAX_SECONDS).contains(&seconds) {
        return Err(CoreError::InvalidInput(format!(
            "expiresInSeconds must be between {GROUP_JOIN_TOKEN_TTL_MIN_SECONDS} and {GROUP_JOIN_TOKEN_TTL_MAX_SECONDS}"
        )));
    }
    Ok(Some(seconds))
}

fn parse_optional_max_uses(value: Option<u32>) -> Result<Option<u32>> {
    let Some(max_uses) = value else {
        return Ok(None);
    };
    if !(GROUP_JOIN_TOKEN_MAX_USES_MIN..=GROUP_JOIN_TOKEN_MAX_USES_MAX).contains(&max_uses) {
        return Err(CoreError::InvalidInput(format!(
            "maxUses must be between {GROUP_JOIN_TOKEN_MAX_USES_MIN} and {GROUP_JOIN_TOKEN_MAX_USES_MAX}"
        )));
    }
    Ok(Some(max_uses))
}

fn parse_group_record(payload: GroupPayload) -> Result<GroupRecord> {
    Ok(GroupRecord {
        id: parse_group_id(&payload.id)?,
        name: parse_non_empty(&payload.name, "group.name")?,
    })
}

fn parse_group_join_token_record(payload: GroupJoinTokenPayload) -> Result<GroupJoinTokenRecord> {
    Ok(GroupJoinTokenRecord {
        id: parse_non_empty(&payload.id, "groupJoinToken.id")?,
        token: parse_group_join_token(&payload.token)?,
        group_id: parse_group_id(&payload.group_id)?,
        role: payload.role,
        max_uses: parse_optional_max_uses(Some(payload.max_uses))?
            .ok_or_else(|| CoreError::InvalidInput("maxUses is invalid".to_string()))?,
        expires_at: parse_non_empty(&payload.expires_at, "groupJoinToken.expiresAt")?,
        created_at: parse_non_empty(&payload.created_at, "groupJoinToken.createdAt")?,
    })
}

fn parse_group_join_result(payload: GroupJoinResponsePayload) -> Result<GroupJoinResult> {
    parse_agent_did(&payload.agent_did)?;
    Ok(GroupJoinResult {
        joined: payload.joined,
        group_id: parse_group_id(&payload.group_id)?,
        agent_did: payload.agent_did,
        role: payload.role,
        joined_at: parse_non_empty(&payload.joined_at, "joinedAt")?,
    })
}

fn parse_group_name_from_payload(payload: serde_json::Value) -> Result<String> {
    payload
        .get("group")
        .and_then(|group| group.get("name"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| CoreError::InvalidInput("group response is invalid".to_string()))
}

fn parse_group_members_result(
    payload: GroupMembersListResponsePayload,
) -> Result<GroupMembersListResult> {
    let mut members: Vec<GroupMemberRecord> = Vec::with_capacity(payload.members.len());
    for member in payload.members {
        parse_agent_did(&member.agent_did)?;
        members.push(GroupMemberRecord {
            agent_did: member.agent_did,
            role: member.role,
            joined_at: parse_non_empty(&member.joined_at, "members[].joinedAt")?,
        });
    }

    Ok(GroupMembersListResult {
        group: GroupMembersListGroup {
            id: parse_group_id(&payload.group.id)?,
        },
        members,
    })
}

async fn ensure_success(response: reqwest::Response, context: &str) -> Result<reqwest::Response> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    let message = parse_error_message(&body);
    Err(CoreError::HttpStatus {
        status,
        message: if message.is_empty() {
            context.to_string()
        } else {
            message
        },
    })
}

/// Creates a group owned by the authenticated agent owner.
pub async fn create_group(
    options: &ConfigPathOptions,
    input: GroupCreateInput,
) -> Result<GroupCreateResult> {
    let runtime = load_agent_registry_auth_runtime(options, &input.agent_name)?;
    let name = parse_group_name(&input.name)?;
    let request_url = join_registry_url(&runtime.registry_url, GROUPS_PATH)?;
    let request_body = serde_json::json!({ "name": name });
    let body_bytes = serde_json::to_vec(&request_body)?;
    let response =
        send_signed_agent_request(&runtime, Method::POST, request_url, Some(body_bytes)).await?;
    let payload = ensure_success(response, "group create failed")
        .await?
        .json::<GroupCreateResponsePayload>()
        .await
        .map_err(|error| CoreError::Http(error.to_string()))?;

    Ok(GroupCreateResult {
        group: parse_group_record(payload.group)?,
    })
}

/// Fetches a group by ID using agent-auth.
pub async fn inspect_group(
    options: &ConfigPathOptions,
    input: GroupInspectInput,
) -> Result<GroupInspectResult> {
    let runtime = load_agent_registry_auth_runtime(options, &input.agent_name)?;
    let group_id = parse_group_id(&input.group_id)?;
    let request_url =
        join_registry_url(&runtime.registry_url, &format!("{GROUPS_PATH}/{group_id}"))?;
    let response = send_signed_agent_request(&runtime, Method::GET, request_url, None).await?;
    let payload = ensure_success(response, "group inspect failed")
        .await?
        .json::<GroupInspectResponsePayload>()
        .await
        .map_err(|error| CoreError::Http(error.to_string()))?;

    Ok(GroupInspectResult {
        group: parse_group_record(payload.group)?,
    })
}

/// Creates a group join token for an existing group.
pub async fn create_group_join_token(
    options: &ConfigPathOptions,
    input: GroupJoinTokenCreateInput,
) -> Result<GroupJoinTokenCreateResult> {
    let runtime = load_agent_registry_auth_runtime(options, &input.agent_name)?;
    let group_id = parse_group_id(&input.group_id)?;
    let expires_in_seconds = parse_optional_expires_in_seconds(input.expires_in_seconds)?;
    let max_uses = parse_optional_max_uses(input.max_uses)?;

    let request_url = join_registry_url(
        &runtime.registry_url,
        &format!("{GROUPS_PATH}/{group_id}/join-tokens"),
    )?;
    let mut request_body = serde_json::Map::new();
    if let Some(seconds) = expires_in_seconds {
        request_body.insert(
            "expiresInSeconds".to_string(),
            serde_json::Value::Number(seconds.into()),
        );
    }
    if let Some(uses) = max_uses {
        request_body.insert(
            "maxUses".to_string(),
            serde_json::Value::Number(uses.into()),
        );
    }

    let body_bytes = serde_json::to_vec(&request_body)?;
    let response =
        send_signed_agent_request(&runtime, Method::POST, request_url, Some(body_bytes)).await?;
    let payload = ensure_success(response, "group join token create failed")
        .await?
        .json::<GroupJoinTokenCreateResponsePayload>()
        .await
        .map_err(|error| CoreError::Http(error.to_string()))?;

    Ok(GroupJoinTokenCreateResult {
        group_join_token: parse_group_join_token_record(payload.group_join_token)?,
    })
}

/// Joins a group using a group join token.
pub async fn join_group(
    options: &ConfigPathOptions,
    input: GroupJoinInput,
) -> Result<GroupJoinResult> {
    let runtime = load_agent_registry_auth_runtime(options, &input.agent_name)?;
    let group_join_token = parse_group_join_token(&input.group_join_token)?;

    let request_url = join_registry_url(&runtime.registry_url, GROUP_JOIN_PATH)?;
    let request_body = serde_json::json!({
        "groupJoinToken": group_join_token,
    });
    let body_bytes = serde_json::to_vec(&request_body)?;
    let response =
        send_signed_agent_request(&runtime, Method::POST, request_url, Some(body_bytes)).await?;
    let payload = ensure_success(response, "group join failed")
        .await?
        .json::<GroupJoinResponsePayload>()
        .await
        .map_err(|error| CoreError::Http(error.to_string()))?;
    parse_group_join_result(payload)
}

/// Lists all members for a group.
///
/// The registry currently enforces a hard member ceiling (`MAX_GROUP_MEMBERS = 25`),
/// so this endpoint returns a bounded list without client-side pagination today.
pub async fn list_group_members(
    options: &ConfigPathOptions,
    input: GroupMembersListInput,
) -> Result<GroupMembersListResult> {
    let runtime = load_agent_registry_auth_runtime(options, &input.agent_name)?;
    let group_id = parse_group_id(&input.group_id)?;
    let request_url = join_registry_url(
        &runtime.registry_url,
        &format!("{GROUPS_PATH}/{group_id}/members"),
    )?;
    let response = send_signed_agent_request(&runtime, Method::GET, request_url, None).await?;
    let payload = ensure_success(response, "group members list failed")
        .await?
        .json::<GroupMembersListResponsePayload>()
        .await
        .map_err(|error| CoreError::Http(error.to_string()))?;
    parse_group_members_result(payload)
}

/// Resolves only the group name for a group ID via agent-auth.
pub async fn fetch_group_name_with_agent_auth(
    options: &ConfigPathOptions,
    agent_name: &str,
    group_id: &str,
) -> Result<String> {
    let runtime = load_agent_registry_auth_runtime(options, agent_name)?;
    let normalized_group_id = parse_group_id(group_id)?;
    let request_url = join_registry_url(
        &runtime.registry_url,
        &format!("{GROUPS_PATH}/{normalized_group_id}"),
    )?;
    let response = send_signed_agent_request(&runtime, Method::GET, request_url, None).await?;
    let payload = ensure_success(response, "group inspect failed")
        .await?
        .json::<serde_json::Value>()
        .await
        .map_err(|error| CoreError::Http(error.to_string()))?;
    parse_group_name_from_payload(payload)
}

/// Resolves member agent DIDs for a group via agent-auth.
pub async fn fetch_group_member_dids_with_agent_auth(
    options: &ConfigPathOptions,
    agent_name: &str,
    group_id: &str,
) -> Result<Vec<String>> {
    let result = list_group_members(
        options,
        GroupMembersListInput {
            agent_name: agent_name.to_string(),
            group_id: group_id.to_string(),
        },
    )
    .await?;
    Ok(result
        .members
        .into_iter()
        .map(|member| member.agent_did)
        .collect())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use ed25519_dalek::{SigningKey, VerifyingKey};
    use tempfile::tempdir;
    use wiremock::matchers::{body_json, header_exists, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use crate::config::{CliConfig, ConfigPathOptions, get_config_dir, write_config};
    use crate::constants::{AGENTS_DIR, AIT_FILE_NAME, SECRET_KEY_FILE_NAME};

    use super::{
        GroupCreateInput, GroupJoinInput, GroupJoinTokenCreateInput, GroupRole, create_group,
        create_group_join_token, fetch_group_member_dids_with_agent_auth,
        fetch_group_name_with_agent_auth, join_group, parse_group_join_token, parse_group_name,
    };

    fn fake_ait(agent_did: &str, owner_did: &str, public_key: &str) -> String {
        let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"EdDSA","kid":"test-kid"}"#);
        let payload = URL_SAFE_NO_PAD.encode(format!(
            "{{\"sub\":\"{agent_did}\",\"ownerDid\":\"{owner_did}\",\"framework\":\"openclaw\",\"cnf\":{{\"jwk\":{{\"x\":\"{public_key}\"}}}},\"exp\":2524608000}}"
        ));
        format!("{header}.{payload}.sig")
    }

    fn seed_agent_state(options: &ConfigPathOptions, agent_name: &str, registry_url: &str) {
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
            "{\"tokenType\":\"Bearer\",\"accessToken\":\"agent-access-token\",\"accessExpiresAt\":\"2030-01-01T00:00:00.000Z\",\"refreshToken\":\"refresh-token\",\"refreshExpiresAt\":\"2030-01-02T00:00:00.000Z\"}",
        )
        .expect("write auth");
    }

    #[test]
    fn parse_group_join_token_rejects_invalid_token() {
        assert!(parse_group_join_token("bad_token").is_err());
        assert!(parse_group_join_token("clw_gjt_").is_err());
    }

    #[test]
    fn parse_group_name_counts_characters_not_bytes() {
        let eighty_cjk_chars = "你".repeat(80);
        let eighty_one_cjk_chars = "你".repeat(81);

        assert!(parse_group_name(&eighty_cjk_chars).is_ok());
        assert!(parse_group_name(&eighty_one_cjk_chars).is_err());
    }

    #[tokio::test]
    async fn group_endpoints_use_signed_agent_auth_headers() {
        let server = MockServer::start().await;
        let home = tempdir().expect("tempdir");
        let options = ConfigPathOptions {
            home_dir: Some(home.path().to_path_buf()),
            registry_url_hint: Some(server.uri()),
        };
        seed_agent_state(&options, "alpha", &server.uri());

        Mock::given(method("POST"))
            .and(path("/v1/groups"))
            .and(header_exists("authorization"))
            .and(header_exists("x-claw-agent-access"))
            .and(header_exists("x-claw-proof"))
            .and(body_json(serde_json::json!({ "name": "research-crew" })))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "group": {
                    "id": "grp_01HF7YAT31JZHSMW1CG6Q6MHB7",
                    "name": "research-crew"
                }
            })))
            .mount(&server)
            .await;

        let created = create_group(
            &options,
            GroupCreateInput {
                agent_name: "alpha".to_string(),
                name: "research-crew".to_string(),
            },
        )
        .await
        .expect("group create");
        assert_eq!(created.group.name, "research-crew");
    }

    #[tokio::test]
    async fn group_join_token_create_validates_limits() {
        let server = MockServer::start().await;
        let home = tempdir().expect("tempdir");
        let options = ConfigPathOptions {
            home_dir: Some(home.path().to_path_buf()),
            registry_url_hint: Some(server.uri()),
        };
        seed_agent_state(&options, "alpha", &server.uri());

        let error = create_group_join_token(
            &options,
            GroupJoinTokenCreateInput {
                agent_name: "alpha".to_string(),
                group_id: "grp_01HF7YAT31JZHSMW1CG6Q6MHB7".to_string(),
                expires_in_seconds: Some(59),
                max_uses: None,
            },
        )
        .await
        .expect_err("invalid expires");
        assert!(error.to_string().contains("expiresInSeconds"));

        let error = create_group_join_token(
            &options,
            GroupJoinTokenCreateInput {
                agent_name: "alpha".to_string(),
                group_id: "grp_01HF7YAT31JZHSMW1CG6Q6MHB7".to_string(),
                expires_in_seconds: None,
                max_uses: Some(26),
            },
        )
        .await
        .expect_err("invalid max uses");
        assert!(error.to_string().contains("maxUses"));
    }

    #[tokio::test]
    async fn group_read_helpers_parse_group_and_members() {
        let server = MockServer::start().await;
        let home = tempdir().expect("tempdir");
        let options = ConfigPathOptions {
            home_dir: Some(home.path().to_path_buf()),
            registry_url_hint: Some(server.uri()),
        };
        seed_agent_state(&options, "alpha", &server.uri());

        Mock::given(method("GET"))
            .and(path("/v1/groups/grp_01HF7YAT31JZHSMW1CG6Q6MHB7"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "group": {
                    "id": "grp_01HF7YAT31JZHSMW1CG6Q6MHB7",
                    "name": "research-crew"
                }
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/groups/grp_01HF7YAT31JZHSMW1CG6Q6MHB7/members"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "group": {
                    "id": "grp_01HF7YAT31JZHSMW1CG6Q6MHB7"
                },
                "members": [{
                    "agentDid": "did:cdi:127.0.0.1:agent:01HF7YAT31JZHSMW1CG6Q6MHB9",
                    "role": "member",
                    "joinedAt": "2026-03-01T00:00:00.000Z"
                }]
            })))
            .mount(&server)
            .await;

        let group_name =
            fetch_group_name_with_agent_auth(&options, "alpha", "grp_01HF7YAT31JZHSMW1CG6Q6MHB7")
                .await
                .expect("group name");
        assert_eq!(group_name, "research-crew");

        let members = fetch_group_member_dids_with_agent_auth(
            &options,
            "alpha",
            "grp_01HF7YAT31JZHSMW1CG6Q6MHB7",
        )
        .await
        .expect("group members");
        assert_eq!(members.len(), 1);
        assert_eq!(
            members[0],
            "did:cdi:127.0.0.1:agent:01HF7YAT31JZHSMW1CG6Q6MHB9"
        );
    }

    #[tokio::test]
    async fn group_join_parses_response() {
        let server = MockServer::start().await;
        let home = tempdir().expect("tempdir");
        let options = ConfigPathOptions {
            home_dir: Some(home.path().to_path_buf()),
            registry_url_hint: Some(server.uri()),
        };
        seed_agent_state(&options, "alpha", &server.uri());

        Mock::given(method("POST"))
            .and(path("/v1/groups/join"))
            .and(body_json(serde_json::json!({
                "groupJoinToken": "clw_gjt_abc123"
            })))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "joined": true,
                "groupId": "grp_01HF7YAT31JZHSMW1CG6Q6MHB7",
                "agentDid": "did:cdi:127.0.0.1:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
                "role": "member",
                "joinedAt": "2026-03-01T00:00:00.000Z"
            })))
            .mount(&server)
            .await;

        let joined = join_group(
            &options,
            GroupJoinInput {
                agent_name: "alpha".to_string(),
                group_join_token: "clw_gjt_abc123".to_string(),
            },
        )
        .await
        .expect("group join");
        assert!(joined.joined);
        assert_eq!(joined.role, GroupRole::Member);
    }
}
