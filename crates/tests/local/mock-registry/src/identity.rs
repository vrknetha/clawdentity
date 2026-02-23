use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use serde_json::{Value, json};
use ulid::Ulid;

use crate::api_keys::{create_api_key_record, insert_api_key};
use crate::crypto::make_human_did;
use crate::state::{AdminBootstrapRequest, AppState, error_response};

pub(crate) async fn register_identity_handler(
    State(state): State<AppState>,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    let mut inner = state.inner.lock().await;
    inner.identities.push(payload);
    (
        StatusCode::OK,
        Json(json!({
            "status": "ok",
            "message": "identity registered",
        })),
    )
}

pub(crate) async fn admin_bootstrap_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<AdminBootstrapRequest>,
) -> impl IntoResponse {
    let secret = headers
        .get("x-bootstrap-secret")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if secret.is_none() {
        return error_response(StatusCode::UNAUTHORIZED, "missing x-bootstrap-secret");
    }

    let display_name = body
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Admin")
        .to_string();
    let api_key_name = body
        .api_key_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("admin-cli")
        .to_string();
    let owner_did = make_human_did(&state.registry_url);

    let mut inner = state.inner.lock().await;
    let api_key = create_api_key_record(&owner_did, api_key_name, None);
    insert_api_key(&mut inner, api_key.clone());
    (
        StatusCode::OK,
        Json(json!({
            "human": {
                "id": Ulid::new().to_string(),
                "did": owner_did,
                "displayName": display_name,
                "role": "admin",
                "status": "active",
            },
            "apiKey": {
                "id": api_key.id,
                "name": api_key.name,
                "token": api_key.token,
            },
            "internalService": {
                "id": Ulid::new().to_string(),
                "name": "mock-internal-service",
            },
        })),
    )
}
