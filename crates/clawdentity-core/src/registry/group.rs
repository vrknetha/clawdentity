use reqwest::Method;
use serde::{Deserialize, Serialize};

use crate::config::ConfigPathOptions;
use crate::did::{parse_agent_did, parse_group_id, parse_human_did};
use crate::error::{CoreError, Result};

use super::agent_auth_client::{
    join_registry_url, load_agent_registry_auth_runtime, parse_error_message,
    send_signed_agent_request,
};

const GROUPS_PATH: &str = "/v1/groups";
const GROUP_JOIN_PATH: &str = "/v1/groups/join";
const GROUP_JOIN_TOKEN_MARKER: &str = "clw_gjt_";
const GROUP_NAME_MAX_LENGTH: usize = 80;

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
    pub created_at: String,
    pub active: bool,
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
    pub agent_name: String,
    pub display_name: String,
    pub framework: String,
    pub human_did: String,
    pub status: String,
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
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupJoinTokenResetInput {
    pub agent_name: String,
    pub group_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupJoinTokenRevokeInput {
    pub agent_name: String,
    pub group_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupJoinTokenRevokeResult {
    pub revoked: bool,
    pub group_id: String,
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
    created_at: String,
    active: bool,
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
    agent_name: String,
    display_name: String,
    framework: String,
    human_did: String,
    status: String,
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

fn parse_group_record(payload: GroupPayload) -> Result<GroupRecord> {
    Ok(GroupRecord {
        id: parse_group_id(&payload.id)?,
        name: parse_non_empty(&payload.name, "group.name")?,
    })
}

fn parse_group_member_status(value: &str) -> Result<String> {
    let normalized = parse_non_empty(value, "members[].status")?;
    if normalized == "active" || normalized == "revoked" {
        Ok(normalized)
    } else {
        Err(CoreError::InvalidInput(
            "members[].status is invalid".to_string(),
        ))
    }
}

fn parse_group_join_token_record(payload: GroupJoinTokenPayload) -> Result<GroupJoinTokenRecord> {
    Ok(GroupJoinTokenRecord {
        id: parse_non_empty(&payload.id, "groupJoinToken.id")?,
        token: parse_group_join_token(&payload.token)?,
        group_id: parse_group_id(&payload.group_id)?,
        role: payload.role,
        created_at: parse_non_empty(&payload.created_at, "groupJoinToken.createdAt")?,
        active: payload.active,
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
            agent_name: parse_non_empty(&member.agent_name, "members[].agentName")?,
            display_name: parse_non_empty(&member.display_name, "members[].displayName")?,
            framework: parse_non_empty(&member.framework, "members[].framework")?,
            human_did: {
                parse_human_did(&member.human_did)?;
                member.human_did
            },
            status: parse_group_member_status(&member.status)?,
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

    let request_url = join_registry_url(
        &runtime.registry_url,
        &format!("{GROUPS_PATH}/{group_id}/join-tokens"),
    )?;
    let request_body = serde_json::Map::new();
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

/// Resets the current group join token and returns the newly active token.
pub async fn reset_group_join_token(
    options: &ConfigPathOptions,
    input: GroupJoinTokenResetInput,
) -> Result<GroupJoinTokenCreateResult> {
    let runtime = load_agent_registry_auth_runtime(options, &input.agent_name)?;
    let group_id = parse_group_id(&input.group_id)?;
    let request_url = join_registry_url(
        &runtime.registry_url,
        &format!("{GROUPS_PATH}/{group_id}/join-tokens/reset"),
    )?;
    let response = send_signed_agent_request(
        &runtime,
        Method::POST,
        request_url,
        Some(serde_json::to_vec(&serde_json::Map::<
            String,
            serde_json::Value,
        >::new())?),
    )
    .await?;
    let payload = ensure_success(response, "group join token reset failed")
        .await?
        .json::<GroupJoinTokenCreateResponsePayload>()
        .await
        .map_err(|error| CoreError::Http(error.to_string()))?;

    Ok(GroupJoinTokenCreateResult {
        group_join_token: parse_group_join_token_record(payload.group_join_token)?,
    })
}

/// Revokes the current active group join token without replacement.
pub async fn revoke_group_join_token(
    options: &ConfigPathOptions,
    input: GroupJoinTokenRevokeInput,
) -> Result<GroupJoinTokenRevokeResult> {
    let runtime = load_agent_registry_auth_runtime(options, &input.agent_name)?;
    let group_id = parse_group_id(&input.group_id)?;
    let request_url = join_registry_url(
        &runtime.registry_url,
        &format!("{GROUPS_PATH}/{group_id}/join-tokens/current"),
    )?;
    let response = send_signed_agent_request(&runtime, Method::DELETE, request_url, None).await?;
    if response.status().is_success() {
        return Ok(GroupJoinTokenRevokeResult {
            revoked: true,
            group_id,
        });
    }

    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    let message = parse_error_message(&body);
    Err(CoreError::HttpStatus {
        status,
        message: if message.is_empty() {
            "group join token revoke failed".to_string()
        } else {
            message
        },
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
mod tests;
