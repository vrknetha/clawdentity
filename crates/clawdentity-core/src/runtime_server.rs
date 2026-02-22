use std::future::Future;
use std::net::SocketAddr;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::{Json, Router, routing::get, routing::post};
use serde::Deserialize;
use serde_json::json;

use crate::connector_client::ConnectorClientSender;
use crate::db::SqliteStore;
use crate::db_inbound::{dead_letter_count, list_dead_letter, pending_count};
use crate::db_outbound::{EnqueueOutboundInput, enqueue_outbound, outbound_count};
use crate::did::{ClawDidKind, parse_did};
use crate::error::{CoreError, Result};
use crate::runtime_relay::flush_outbound_queue_to_relay;
use crate::runtime_replay::{purge_dead_letter_messages, replay_dead_letter_messages};

#[derive(Clone)]
pub struct RuntimeServerState {
    pub store: SqliteStore,
    pub relay_sender: Option<ConnectorClientSender>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OutboundRequest {
    to_agent_did: String,
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
    let outbound_pending = outbound_count(&state.store).unwrap_or(0);
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
                    "pendingCount": outbound_pending,
                },
            },
            "inbound": {
                "pending": inbound_pending,
                "deadLetter": inbound_dead_letter,
            }
        })),
    )
}

async fn outbound_handler(
    State(state): State<RuntimeServerState>,
    Json(request): Json<OutboundRequest>,
) -> impl IntoResponse {
    let normalized_to_agent_did = request.to_agent_did.trim().to_string();
    match parse_did(&normalized_to_agent_did) {
        Ok(parsed) if parsed.kind == ClawDidKind::Agent => {}
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "error": {
                        "code": "INVALID_TO_AGENT_DID",
                        "message": "toAgentDid must be a valid agent DID",
                    }
                })),
            );
        }
    }

    let frame_id = ulid::Ulid::new().to_string();
    let enqueue_result = enqueue_outbound(
        &state.store,
        EnqueueOutboundInput {
            frame_id: frame_id.clone(),
            frame_version: 1,
            frame_type: "enqueue".to_string(),
            to_agent_did: normalized_to_agent_did,
            payload_json: request.payload.to_string(),
            conversation_id: request.conversation_id,
            reply_to: request.reply_to,
        },
    );
    if let Err(error) = enqueue_result {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({
                "error": {
                    "code": "OUTBOUND_PERSIST_FAILED",
                    "message": error.to_string(),
                }
            })),
        );
    }

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
mod tests {
    use axum::body::{Body, to_bytes};
    use axum::http::{Request, StatusCode};
    use serde_json::Value;
    use tempfile::TempDir;
    use tower::ServiceExt;

    use crate::db::SqliteStore;
    use crate::db_outbound::outbound_count;

    use super::{RuntimeServerState, create_runtime_router};

    #[tokio::test]
    async fn status_endpoint_returns_ok_payload() {
        let temp = TempDir::new().expect("temp dir");
        let store = SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("open db");
        let app = create_runtime_router(RuntimeServerState {
            store,
            relay_sender: None,
        });

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/v1/status")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("bytes");
        let payload: Value = serde_json::from_slice(&body).expect("json");
        assert_eq!(
            payload.get("status").and_then(|value| value.as_str()),
            Some("ok")
        );
    }

    #[tokio::test]
    async fn outbound_endpoint_enqueues_message() {
        let temp = TempDir::new().expect("temp dir");
        let store = SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("open db");
        let app = create_runtime_router(RuntimeServerState {
            store: store.clone(),
            relay_sender: None,
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/outbound")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        "{\"toAgentDid\":\"did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4\",\"payload\":{\"hello\":\"world\"}}",
                    ))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        assert_eq!(outbound_count(&store).expect("count"), 1);
    }
}
