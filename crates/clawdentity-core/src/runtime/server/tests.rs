use std::sync::Arc;

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use serde_json::Value;
use tempfile::TempDir;
use tokio::sync::mpsc;
use tower::ServiceExt;

use crate::db::SqliteStore;
use crate::db_outbound::{EnqueueOutboundInput, enqueue_outbound, list_outbound, outbound_count};

use super::{RuntimeServerState, create_runtime_router, resolve_outbound_flush_batch_size};

#[tokio::test]
async fn status_endpoint_returns_ok_payload() {
    let temp = TempDir::new().expect("temp dir");
    let store = SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("open db");
    let app = create_runtime_router(RuntimeServerState {
        store,
        relay_sender: None,
        outbound_max_pending_override: None,
        group_members_resolver: None,
        local_agent_did: None,
        local_group_echo_sender: None,
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
        outbound_max_pending_override: None,
        group_members_resolver: None,
        local_agent_did: None,
        local_group_echo_sender: None,
    });

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/outbound")
                .header("content-type", "application/json")
                .body(Body::from(
                    "{\"toAgentDid\":\"did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4\",\"payload\":{\"hello\":\"world\"}}",
                ))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    assert_eq!(outbound_count(&store).expect("count"), 1);
}

#[test]
fn flush_batch_size_uses_pending_queue_depth_when_available() {
    let temp = TempDir::new().expect("temp dir");
    let store = SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("open db");
    enqueue_outbound(
        &store,
        EnqueueOutboundInput {
            frame_id: "frame-1".to_string(),
            frame_version: 1,
            frame_type: "enqueue".to_string(),
            to_agent_did: "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4"
                .to_string(),
            group_id: None,
            payload_json: "{\"hello\":\"one\"}".to_string(),
            conversation_id: None,
            reply_to: None,
        },
    )
    .expect("enqueue first");
    enqueue_outbound(
        &store,
        EnqueueOutboundInput {
            frame_id: "frame-2".to_string(),
            frame_version: 1,
            frame_type: "enqueue".to_string(),
            to_agent_did: "did:cdi:registry.clawdentity.com:agent:01HF7YAT31JZHSMW1CG6Q6MHB7"
                .to_string(),
            group_id: Some("grp_01HF7YAT31JZHSMW1CG6Q6MHB7".to_string()),
            payload_json: "{\"hello\":\"two\"}".to_string(),
            conversation_id: None,
            reply_to: None,
        },
    )
    .expect("enqueue second");

    let state = RuntimeServerState {
        store,
        relay_sender: None,
        outbound_max_pending_override: None,
        group_members_resolver: None,
        local_agent_did: None,
        local_group_echo_sender: None,
    };

    assert_eq!(resolve_outbound_flush_batch_size(&state, 1), 2);
}

#[tokio::test]
async fn outbound_endpoint_persists_conversation_id_when_present() {
    let temp = TempDir::new().expect("temp dir");
    let store = SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("open db");
    let app = create_runtime_router(RuntimeServerState {
        store: store.clone(),
        relay_sender: None,
        outbound_max_pending_override: None,
        group_members_resolver: None,
        local_agent_did: None,
        local_group_echo_sender: None,
    });

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/outbound")
                .header("content-type", "application/json")
                .body(Body::from(
                    "{\"toAgentDid\":\"did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4\",\"conversationId\":\"pair:conv-alpha-beta\",\"payload\":{\"hello\":\"world\"}}",
                ))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::ACCEPTED);

    let outbound = list_outbound(&store, 10).expect("outbound rows");
    assert_eq!(outbound.len(), 1);
    assert_eq!(
        outbound[0].conversation_id.as_deref(),
        Some("pair:conv-alpha-beta")
    );
}

#[tokio::test]
async fn outbound_endpoint_rejects_when_to_agent_did_and_group_id_are_both_present() {
    let temp = TempDir::new().expect("temp dir");
    let store = SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("open db");
    let app = create_runtime_router(RuntimeServerState {
        store,
        relay_sender: None,
        outbound_max_pending_override: None,
        group_members_resolver: None,
        local_agent_did: None,
        local_group_echo_sender: None,
    });

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/outbound")
                .header("content-type", "application/json")
                .body(Body::from(
                    "{\"toAgentDid\":\"did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4\",\"groupId\":\"grp_01HF7YAT31JZHSMW1CG6Q6MHB7\",\"payload\":{\"hello\":\"world\"}}",
                ))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn outbound_endpoint_fans_out_group_delivery_excluding_sender() {
    let temp = TempDir::new().expect("temp dir");
    let store = SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("open db");
    let local_agent_did =
        "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4".to_string();
    let app = create_runtime_router(RuntimeServerState {
        store: store.clone(),
        relay_sender: None,
        outbound_max_pending_override: None,
        group_members_resolver: Some(Arc::new(|_group_id| {
            Box::pin(async {
                Ok(vec![
                    "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4".to_string(),
                    "did:cdi:registry.clawdentity.com:agent:01HF7YAT31JZHSMW1CG6Q6MHB7".to_string(),
                    "did:cdi:registry.clawdentity.com:agent:01HF7YAT8M89D8W9DH2S5Y4JQK".to_string(),
                ])
            })
        })),
        local_agent_did: Some(local_agent_did),
        local_group_echo_sender: None,
    });

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/outbound")
                .header("content-type", "application/json")
                .body(Body::from(
                    "{\"groupId\":\"grp_01HF7YAT31JZHSMW1CG6Q6MHB7\",\"payload\":{\"hello\":\"group\"}}",
                ))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::ACCEPTED);

    let outbound = list_outbound(&store, 10).expect("outbound rows");
    assert_eq!(outbound.len(), 2);
    assert!(
        outbound
            .iter()
            .all(|item| item.group_id.as_deref() == Some("grp_01HF7YAT31JZHSMW1CG6Q6MHB7"))
    );
}

#[tokio::test]
async fn outbound_endpoint_emits_local_group_echo_without_counting_remote_recipient() {
    let temp = TempDir::new().expect("temp dir");
    let store = SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("open db");
    let local_agent_did =
        "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4".to_string();
    let (echo_tx, mut echo_rx) = mpsc::unbounded_channel();
    let app = create_runtime_router(RuntimeServerState {
        store: store.clone(),
        relay_sender: None,
        outbound_max_pending_override: None,
        group_members_resolver: Some(Arc::new(|_group_id| {
            Box::pin(async {
                Ok(vec![
                    "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4".to_string(),
                    "did:cdi:registry.clawdentity.com:agent:01HF7YAT31JZHSMW1CG6Q6MHB7".to_string(),
                ])
            })
        })),
        local_agent_did: Some(local_agent_did.clone()),
        local_group_echo_sender: Some(echo_tx),
    });

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/outbound")
                .header("content-type", "application/json")
                .body(Body::from(
                    "{\"groupId\":\"grp_01HF7YAT31JZHSMW1CG6Q6MHB7\",\"conversationId\":\"grp-thread-1\",\"payload\":{\"hello\":\"group\"}}",
                ))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::ACCEPTED);

    let outbound = list_outbound(&store, 10).expect("outbound rows");
    assert_eq!(outbound.len(), 1);

    let local_echo = echo_rx.try_recv().expect("local echo");
    assert_eq!(local_echo.local_agent_did, local_agent_did);
    assert_eq!(local_echo.group_id, "grp_01HF7YAT31JZHSMW1CG6Q6MHB7");
    assert_eq!(local_echo.conversation_id.as_deref(), Some("grp-thread-1"));
    assert_eq!(
        local_echo
            .payload
            .get("hello")
            .and_then(|value| value.as_str()),
        Some("group")
    );
}

#[tokio::test]
async fn outbound_endpoint_rejects_legacy_peer_did_payload() {
    let temp = TempDir::new().expect("temp dir");
    let store = SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("open db");
    let app = create_runtime_router(RuntimeServerState {
        store: store.clone(),
        relay_sender: None,
        outbound_max_pending_override: None,
        group_members_resolver: None,
        local_agent_did: None,
        local_group_echo_sender: None,
    });

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/outbound")
                .header("content-type", "application/json")
                .body(Body::from(
                    "{\"peer\":\"beta\",\"peerDid\":\"did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4\",\"peerProxyUrl\":\"https://example.test/hooks/agent\",\"payload\":{\"hello\":\"world\"}}",
                ))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("bytes");
    let payload: Value = serde_json::from_slice(&body).expect("json");
    assert_eq!(
        payload
            .get("error")
            .and_then(|value| value.get("code"))
            .and_then(|value| value.as_str()),
        Some("INVALID_OUTBOUND_ROUTE")
    );
    assert_eq!(outbound_count(&store).expect("count"), 0);
}

#[tokio::test]
async fn outbound_endpoint_returns_507_when_queue_limit_reached() {
    let temp = TempDir::new().expect("temp dir");
    let store = SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("open db");
    let app = create_runtime_router(RuntimeServerState {
        store: store.clone(),
        relay_sender: None,
        outbound_max_pending_override: Some(1),
        group_members_resolver: None,
        local_agent_did: None,
        local_group_echo_sender: None,
    });

    let first = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/outbound")
                .header("content-type", "application/json")
                .body(Body::from(
                    "{\"toAgentDid\":\"did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4\",\"payload\":{\"hello\":\"world\"}}",
                ))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(first.status(), StatusCode::ACCEPTED);

    let second = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/outbound")
                .header("content-type", "application/json")
                .body(Body::from(
                    "{\"toAgentDid\":\"did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4\",\"payload\":{\"hello\":\"again\"}}",
                ))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(second.status(), StatusCode::INSUFFICIENT_STORAGE);
}
