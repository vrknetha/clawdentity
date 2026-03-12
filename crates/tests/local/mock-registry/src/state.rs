use std::collections::HashMap;
use std::sync::Arc;

use axum::Json;
use axum::http::StatusCode;
use ed25519_dalek::SigningKey;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Mutex;

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) registry_url: String,
    pub(crate) proxy_url: String,
    pub(crate) signing: Arc<SigningMaterial>,
    pub(crate) inner: Arc<Mutex<InnerState>>,
}

pub(crate) struct SigningMaterial {
    pub(crate) kid: String,
    pub(crate) signing_key: SigningKey,
    pub(crate) public_key_x: String,
}

#[derive(Default)]
pub(crate) struct InnerState {
    pub(crate) identities: Vec<Value>,
    pub(crate) challenges: HashMap<String, ChallengeRecord>,
    pub(crate) agents: HashMap<String, AgentRecord>,
    pub(crate) refresh_tokens: HashMap<String, String>,
    pub(crate) api_keys: HashMap<String, ApiKeyRecord>,
    pub(crate) api_keys_by_owner: HashMap<String, Vec<String>>,
    pub(crate) api_key_owner_by_token: HashMap<String, String>,
    pub(crate) invites: HashMap<String, InviteRecord>,
    pub(crate) pairings: HashMap<String, PairingRecord>,
}

#[derive(Clone)]
pub(crate) struct ChallengeRecord {
    pub(crate) owner_did: String,
    pub(crate) public_key: String,
}

#[derive(Clone)]
pub(crate) struct AgentRecord {
    pub(crate) did: String,
    pub(crate) owner_did: String,
}

#[derive(Clone)]
pub(crate) struct ApiKeyRecord {
    pub(crate) id: String,
    pub(crate) owner_did: String,
    pub(crate) name: String,
    pub(crate) status: String,
    pub(crate) created_at: String,
    pub(crate) last_used_at: Option<String>,
    pub(crate) token: String,
}

#[derive(Clone)]
pub(crate) struct InviteRecord {
    pub(crate) code: String,
    pub(crate) id: String,
    pub(crate) owner_did: String,
    pub(crate) created_at: String,
    pub(crate) expires_at: Option<String>,
    pub(crate) redeemed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairProfile {
    pub(crate) agent_name: String,
    pub(crate) human_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) proxy_origin: Option<String>,
}

#[derive(Clone)]
pub(crate) struct PairingRecord {
    pub(crate) initiator_agent_did: String,
    pub(crate) initiator_profile: PairProfile,
    pub(crate) responder_agent_did: Option<String>,
    pub(crate) responder_profile: Option<PairProfile>,
    pub(crate) expires_at: String,
    pub(crate) confirmed_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentChallengeRequest {
    pub(crate) public_key: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentRegisterRequest {
    pub(crate) name: String,
    pub(crate) public_key: String,
    pub(crate) challenge_id: String,
    pub(crate) challenge_signature: String,
    pub(crate) framework: Option<String>,
    pub(crate) ttl_days: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentAuthRefreshRequest {
    pub(crate) refresh_token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApiKeyCreateRequest {
    pub(crate) name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InviteCreateRequest {
    pub(crate) expires_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InviteRedeemRequest {
    pub(crate) code: String,
    pub(crate) display_name: String,
    pub(crate) api_key_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AdminBootstrapRequest {
    pub(crate) display_name: Option<String>,
    pub(crate) api_key_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairStartRequest {
    pub(crate) ttl_seconds: Option<u64>,
    pub(crate) initiator_profile: PairProfile,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairConfirmRequest {
    pub(crate) ticket: String,
    pub(crate) responder_profile: PairProfile,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairStatusRequest {
    pub(crate) ticket: String,
}

pub(crate) fn error_response(status: StatusCode, message: &str) -> (StatusCode, Json<Value>) {
    (
        status,
        Json(json!({
            "error": {
                "message": message,
            }
        })),
    )
}
