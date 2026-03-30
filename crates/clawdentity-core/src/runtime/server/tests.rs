use std::sync::Arc;

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use serde_json::Value;
use tempfile::TempDir;
use tower::ServiceExt;

use crate::db::SqliteStore;
use crate::db_outbound::{list_outbound, outbound_count};

use super::{RuntimeServerState, create_runtime_router};

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
async fn outbound_endpoint_rejects_legacy_peer_did_payload() {
    let temp = TempDir::new().expect("temp dir");
    let store = SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("open db");
    let app = create_runtime_router(RuntimeServerState {
        store: store.clone(),
        relay_sender: None,
        outbound_max_pending_override: None,
        group_members_resolver: None,
        local_agent_did: None,
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
