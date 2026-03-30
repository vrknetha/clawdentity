use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::{Json, Router, routing::get, routing::post};
use serde::Deserialize;
use serde_json::json;

use crate::connector_client::ConnectorClientSender;
use crate::db::{SqliteStore, now_utc_ms};
use crate::db_inbound::{dead_letter_count, list_dead_letter, pending_count};
use crate::db_outbound::{
    EnqueueOutboundInput, delete_outbound, enqueue_outbound, outbound_dead_letter_count,
    outbound_queue_stats,
};
use crate::did::{parse_agent_did, parse_group_id};
use crate::error::{CoreError, Result};
use crate::runtime_relay::flush_outbound_queue_to_relay;
use crate::runtime_replay::{purge_dead_letter_messages, replay_dead_letter_messages};

const DEFAULT_OUTBOUND_MAX_PENDING: i64 = 10_000;
type GroupMembersFuture =
    Pin<Box<dyn Future<Output = std::result::Result<Vec<String>, String>> + Send>>;

pub type ResolveGroupMembers = Arc<dyn Fn(String) -> GroupMembersFuture + Send + Sync>;

#[derive(Clone)]
pub struct RuntimeServerState {
    pub store: SqliteStore,
    pub relay_sender: Option<ConnectorClientSender>,
    pub outbound_max_pending_override: Option<i64>,
    pub group_members_resolver: Option<ResolveGroupMembers>,
    pub local_agent_did: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OutboundRequest {
    #[serde(default)]
    to_agent_did: Option<String>,
    #[serde(default)]
    group_id: Option<String>,
    payload: serde_json::Value,
    #[serde(default)]
    conversation_id: Option<String>,
    #[serde(default)]
    reply_to: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeadLetterMutationRequest {
    #[serde(default)]
    request_ids: Option<Vec<String>>,
}

/// TODO(clawdentity): document `create_runtime_router`.
pub fn create_runtime_router(state: RuntimeServerState) -> Router {
    Router::new()
        .route("/v1/status", get(status_handler))
        .route("/v1/outbound", post(outbound_handler))
        .route("/v1/inbound/dead-letter", get(dead_letter_list_handler))
        .route(
            "/v1/inbound/dead-letter/replay",
            post(dead_letter_replay_handler),
        )
        .route(
            "/v1/inbound/dead-letter/purge",
            post(dead_letter_purge_handler),
        )
        .with_state(state)
}

/// TODO(clawdentity): document `run_runtime_server`.
pub async fn run_runtime_server(
    bind_addr: SocketAddr,
    state: RuntimeServerState,
    shutdown_signal: impl Future<Output = ()> + Send + 'static,
) -> Result<()> {
    let listener = tokio::net::TcpListener::bind(bind_addr)
        .await
        .map_err(|error| CoreError::Http(error.to_string()))?;
    axum::serve(listener, create_runtime_router(state))
        .with_graceful_shutdown(shutdown_signal)
        .await
        .map_err(|error| CoreError::Http(error.to_string()))?;
    Ok(())
}

async fn status_handler(State(state): State<RuntimeServerState>) -> impl IntoResponse {
    let now_ms = now_utc_ms();
    let outbound_stats = outbound_queue_stats(&state.store, now_ms).unwrap_or({
        crate::db_outbound::OutboundQueueStats {
            pending_count: 0,
            retrying_count: 0,
            oldest_created_at_ms: None,
            next_retry_at_ms: None,
        }
    });
    let outbound_dead_letter = outbound_dead_letter_count(&state.store).unwrap_or(0);
    let inbound_pending = pending_count(&state.store).unwrap_or(0);
    let inbound_dead_letter = dead_letter_count(&state.store).unwrap_or(0);
    let relay = state.relay_sender.as_ref();

    (
        StatusCode::OK,
        Json(json!({
            "status": "ok",
            "websocket": {
                "connected": relay.map(|sender| sender.is_connected()).unwrap_or(false),
                "metrics": relay.map(|sender| sender.metrics_snapshot()),
            },
            "outbound": {
                "queue": {
                    "pendingCount": outbound_stats.pending_count,
                    "retryingCount": outbound_stats.retrying_count,
                    "deadLetterCount": outbound_dead_letter,
                    "oldestAgeMs": outbound_stats
                        .oldest_created_at_ms
                        .map(|created_at_ms| now_ms.saturating_sub(created_at_ms)),
                    "nextRetryAtMs": outbound_stats.next_retry_at_ms,
                },
            },
            "inbound": {
                "pending": inbound_pending,
                "deadLetter": inbound_dead_letter,
            }
        })),
    )
}

enum OutboundRouting {
    Direct { to_agent_did: String },
    Group { group_id: String },
}

fn parse_optional_non_empty(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn resolve_outbound_routing(
    request: &OutboundRequest,
) -> std::result::Result<OutboundRouting, AppErrorResponse> {
    let to_agent_did = parse_optional_non_empty(request.to_agent_did.clone());
    let group_id = parse_optional_non_empty(request.group_id.clone());

    match (to_agent_did, group_id) {
        (Some(_), Some(_)) => Err(AppErrorResponse {
            status: StatusCode::BAD_REQUEST,
            code: "INVALID_OUTBOUND_ROUTE",
            message: "Provide exactly one of toAgentDid or groupId",
        }),
        (None, None) => Err(AppErrorResponse {
            status: StatusCode::BAD_REQUEST,
            code: "INVALID_OUTBOUND_ROUTE",
            message: "Provide exactly one of toAgentDid or groupId",
        }),
        (Some(to_agent_did), None) => {
            if parse_agent_did(&to_agent_did).is_err() {
                return Err(AppErrorResponse {
                    status: StatusCode::BAD_REQUEST,
                    code: "INVALID_TO_AGENT_DID",
                    message: "toAgentDid must be a valid agent DID",
                });
            }

            Ok(OutboundRouting::Direct { to_agent_did })
        }
        (None, Some(group_id)) => {
            if parse_group_id(&group_id).is_err() {
                return Err(AppErrorResponse {
                    status: StatusCode::BAD_REQUEST,
                    code: "INVALID_GROUP_ID",
                    message: "groupId must be a valid group ID",
                });
            }

            Ok(OutboundRouting::Group { group_id })
        }
    }
}

struct AppErrorResponse {
    status: StatusCode,
    code: &'static str,
    message: &'static str,
}

fn to_error_response(error: AppErrorResponse) -> (StatusCode, Json<serde_json::Value>) {
    (
        error.status,
        Json(json!({
            "error": {
                "code": error.code,
                "message": error.message,
            }
        })),
    )
}

fn ensure_outbound_capacity(
    state: &RuntimeServerState,
    required_slots: i64,
) -> std::result::Result<(), (StatusCode, Json<serde_json::Value>)> {
    let max_pending = resolve_outbound_max_pending(state);
    let current_pending = outbound_queue_stats(&state.store, now_utc_ms())
        .map(|stats| stats.pending_count)
        .unwrap_or(0);
    let remaining_capacity = max_pending.saturating_sub(current_pending);
    if remaining_capacity < required_slots {
        return Err((
            StatusCode::INSUFFICIENT_STORAGE,
            Json(json!({
                "error": {
                    "code": "CONNECTOR_OUTBOUND_QUEUE_FULL",
                    "message": "Connector outbound queue is full",
                }
            })),
        ));
    }

    Ok(())
}

fn enqueue_outbound_frame(
    state: &RuntimeServerState,
    to_agent_did: String,
    group_id: Option<String>,
    payload: &serde_json::Value,
    conversation_id: Option<String>,
    reply_to: Option<String>,
) -> std::result::Result<String, (StatusCode, Json<serde_json::Value>)> {
    let frame_id = ulid::Ulid::new().to_string();
    let enqueue_result = enqueue_outbound(
        &state.store,
        EnqueueOutboundInput {
            frame_id: frame_id.clone(),
            frame_version: 1,
            frame_type: "enqueue".to_string(),
            to_agent_did,
            group_id,
            payload_json: payload.to_string(),
            conversation_id,
            reply_to,
        },
    );
    if let Err(error) = enqueue_result {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({
                "error": {
                    "code": "OUTBOUND_PERSIST_FAILED",
                    "message": error.to_string(),
                }
            })),
        ));
    }

    Ok(frame_id)
}

#[allow(clippy::too_many_lines)]
async fn outbound_handler(
    State(state): State<RuntimeServerState>,
    Json(request): Json<OutboundRequest>,
) -> impl IntoResponse {
    let routing = match resolve_outbound_routing(&request) {
        Ok(routing) => routing,
        Err(error) => return to_error_response(error),
    };

    match routing {
        OutboundRouting::Direct { to_agent_did } => {
            if let Err(error) = ensure_outbound_capacity(&state, 1) {
                return error;
            }

            let frame_id = match enqueue_outbound_frame(
                &state,
                to_agent_did,
                None,
                &request.payload,
                request.conversation_id.clone(),
                request.reply_to.clone(),
            ) {
                Ok(frame_id) => frame_id,
                Err(error) => return error,
            };

            if let Some(relay_sender) = &state.relay_sender {
                let _ = flush_outbound_queue_to_relay(&state.store, relay_sender, 1, None).await;
            }

            (
                StatusCode::ACCEPTED,
                Json(json!({
                    "accepted": true,
                    "frameId": frame_id,
                })),
            )
        }
        OutboundRouting::Group { group_id } => {
            let local_agent_did = match parse_optional_non_empty(state.local_agent_did.clone()) {
                Some(value) => value,
                None => {
                    return to_error_response(AppErrorResponse {
                        status: StatusCode::SERVICE_UNAVAILABLE,
                        code: "GROUP_MEMBERSHIP_UNAVAILABLE",
                        message: "Group membership verification is unavailable",
                    });
                }
            };
            if parse_agent_did(&local_agent_did).is_err() {
                return to_error_response(AppErrorResponse {
                    status: StatusCode::SERVICE_UNAVAILABLE,
                    code: "GROUP_MEMBERSHIP_UNAVAILABLE",
                    message: "Group membership verification is unavailable",
                });
            }

            let resolver = match state.group_members_resolver.clone() {
                Some(resolver) => resolver,
                None => {
                    return to_error_response(AppErrorResponse {
                        status: StatusCode::SERVICE_UNAVAILABLE,
                        code: "GROUP_MEMBERSHIP_UNAVAILABLE",
                        message: "Group membership verification is unavailable",
                    });
                }
            };

            let raw_members = match resolver(group_id.clone()).await {
                Ok(members) => members,
                Err(_) => {
                    return to_error_response(AppErrorResponse {
                        status: StatusCode::SERVICE_UNAVAILABLE,
                        code: "GROUP_MEMBERSHIP_LOOKUP_FAILED",
                        message: "Group membership verification is unavailable",
                    });
                }
            };

            let mut recipients: Vec<String> = Vec::new();
            for member in raw_members {
                let trimmed = member.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if parse_agent_did(trimmed).is_err() {
                    return (
                        StatusCode::BAD_GATEWAY,
                        Json(json!({
                            "error": {
                                "code": "GROUP_MEMBERSHIP_INVALID_RESPONSE",
                                "message": "Group membership response is invalid",
                            }
                        })),
                    );
                }
                if trimmed == local_agent_did {
                    continue;
                }
                if !recipients.iter().any(|value| value == trimmed) {
                    recipients.push(trimmed.to_string());
                }
            }

            if recipients.is_empty() {
                return (
                    StatusCode::ACCEPTED,
                    Json(json!({
                        "accepted": true,
                        "groupId": group_id,
                        "frameIds": [],
                        "enqueuedRecipients": 0,
                    })),
                );
            }

            let required_slots = match i64::try_from(recipients.len()) {
                Ok(value) => value,
                Err(_) => {
                    return (
                        StatusCode::INSUFFICIENT_STORAGE,
                        Json(json!({
                            "error": {
                                "code": "CONNECTOR_OUTBOUND_QUEUE_FULL",
                                "message": "Connector outbound queue is full",
                            }
                        })),
                    );
                }
            };
            if let Err(error) = ensure_outbound_capacity(&state, required_slots) {
                return error;
            }

            let mut frame_ids: Vec<String> = Vec::with_capacity(recipients.len());
            for recipient in recipients {
                match enqueue_outbound_frame(
                    &state,
                    recipient,
                    Some(group_id.clone()),
                    &request.payload,
                    request.conversation_id.clone(),
                    request.reply_to.clone(),
                ) {
                    Ok(frame_id) => frame_ids.push(frame_id),
                    Err(error) => {
                        for frame_id in &frame_ids {
                            let _ = delete_outbound(&state.store, frame_id);
                        }
                        return error;
                    }
                }
            }

            if let Some(relay_sender) = &state.relay_sender {
                let _ = flush_outbound_queue_to_relay(
                    &state.store,
                    relay_sender,
                    frame_ids.len(),
                    None,
                )
                .await;
            }
            let enqueued_recipients = frame_ids.len();

            (
                StatusCode::ACCEPTED,
                Json(json!({
                    "accepted": true,
                    "groupId": group_id,
                    "frameIds": frame_ids,
                    "enqueuedRecipients": enqueued_recipients,
                })),
            )
        }
    }
}

fn resolve_outbound_max_pending(state: &RuntimeServerState) -> i64 {
    if let Some(override_limit) = state.outbound_max_pending_override {
        return override_limit.max(1);
    }

    std::env::var("CONNECTOR_OUTBOUND_MAX_PENDING")
        .ok()
        .and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_OUTBOUND_MAX_PENDING)
}

async fn dead_letter_list_handler(State(state): State<RuntimeServerState>) -> impl IntoResponse {
    match list_dead_letter(&state.store, 500) {
        Ok(items) => (
            StatusCode::OK,
            Json(json!({
                "status": "ok",
                "count": items.len(),
                "items": items,
            })),
        ),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({
                "error": {
                    "code": "DEAD_LETTER_LIST_FAILED",
                    "message": error.to_string(),
                }
            })),
        ),
    }
}

async fn dead_letter_replay_handler(
    State(state): State<RuntimeServerState>,
    body: Option<Json<DeadLetterMutationRequest>>,
) -> impl IntoResponse {
    let request_ids = body
        .and_then(|body| body.0.request_ids)
        .map(normalize_request_ids);
    match replay_dead_letter_messages(&state.store, request_ids) {
        Ok(result) => (
            StatusCode::OK,
            Json(json!({
                "status": "ok",
                "replayedCount": result.replayed_count,
            })),
        ),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({
                "error": {
                    "code": "DEAD_LETTER_REPLAY_FAILED",
                    "message": error.to_string(),
                }
            })),
        ),
    }
}

async fn dead_letter_purge_handler(
    State(state): State<RuntimeServerState>,
    body: Option<Json<DeadLetterMutationRequest>>,
) -> impl IntoResponse {
    let request_ids = body
        .and_then(|body| body.0.request_ids)
        .map(normalize_request_ids);
    match purge_dead_letter_messages(&state.store, request_ids) {
        Ok(result) => (
            StatusCode::OK,
            Json(json!({
                "status": "ok",
                "purgedCount": result.purged_count,
            })),
        ),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({
                "error": {
                    "code": "DEAD_LETTER_PURGE_FAILED",
                    "message": error.to_string(),
                }
            })),
        ),
    }
}

fn normalize_request_ids(request_ids: Vec<String>) -> Vec<String> {
    request_ids
        .into_iter()
        .filter_map(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        })
        .collect()
}

#[cfg(test)]
mod tests;
