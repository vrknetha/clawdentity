use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::ws::Message;
use clawdentity_core::ConnectorFrame;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{Mutex, mpsc};

pub const DEFAULT_PROXY_PORT: u16 = 13371;
pub const PAIRING_TICKET_PREFIX: &str = "clwpair1_";

#[derive(Clone)]
pub struct AppState {
    pub proxy_url: String,
    pub routes: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<Message>>>>,
    pub queued: Arc<Mutex<HashMap<String, Vec<ConnectorFrame>>>>,
    pub pairings: Arc<Mutex<HashMap<String, PairingRecord>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairProfile {
    pub agent_name: String,
    pub human_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy_origin: Option<String>,
}

#[derive(Clone)]
pub struct PairingRecord {
    pub initiator_agent_did: String,
    pub initiator_profile: PairProfile,
    pub responder_agent_did: Option<String>,
    pub responder_profile: Option<PairProfile>,
    pub expires_at: String,
    pub confirmed_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairStartRequest {
    pub ttl_seconds: Option<u64>,
    pub initiator_profile: PairProfile,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairConfirmRequest {
    pub ticket: String,
    pub responder_profile: PairProfile,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairStatusRequest {
    pub ticket: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayDeliverRequest {
    pub from_agent_did: Option<String>,
    pub to_agent_did: String,
    pub payload: Value,
    #[serde(default)]
    pub content_type: Option<String>,
    #[serde(default)]
    pub conversation_id: Option<String>,
    #[serde(default)]
    pub reply_to: Option<String>,
}
