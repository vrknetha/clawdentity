use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use chrono::Utc;
use serde_json::json;
use ulid::Ulid;

use crate::crypto::{make_human_did, parse_bearer_token};
use crate::state::{ApiKeyCreateRequest, ApiKeyRecord, AppState, InnerState, error_response};

pub(crate) async fn create_api_key_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ApiKeyCreateRequest>,
) -> impl IntoResponse {
    let bearer = match parse_bearer_token(&headers) {
        Some(token) => token,
        None => return error_response(StatusCode::UNAUTHORIZED, "missing bearer token"),
    };
    let owner_did = ensure_owner_for_api_token(&state, &bearer).await;
    let mut inner = state.inner.lock().await;
    let name = body
        .name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("primary")
        .to_string();
    let api_key = create_api_key_record(&owner_did, name, None);
    insert_api_key(&mut inner, api_key.clone());
    (
        StatusCode::OK,
        Json(json!({
            "apiKey": {
                "id": api_key.id,
                "name": api_key.name,
                "status": api_key.status,
                "createdAt": api_key.created_at,
                "lastUsedAt": api_key.last_used_at,
                "token": api_key.token,
            }
        })),
    )
}

pub(crate) async fn list_api_keys_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let bearer = match parse_bearer_token(&headers) {
        Some(token) => token,
        None => return error_response(StatusCode::UNAUTHORIZED, "missing bearer token"),
    };
    let owner_did = ensure_owner_for_api_token(&state, &bearer).await;
    let inner = state.inner.lock().await;
    let ids = inner
        .api_keys_by_owner
        .get(&owner_did)
        .cloned()
        .unwrap_or_default();
    let api_keys = ids
        .iter()
        .filter_map(|id| inner.api_keys.get(id))
        .map(|record| {
            json!({
                "id": record.id,
                "name": record.name,
                "status": record.status,
                "createdAt": record.created_at,
                "lastUsedAt": record.last_used_at,
            })
        })
        .collect::<Vec<_>>();
    (StatusCode::OK, Json(json!({ "apiKeys": api_keys })))
}

pub(crate) async fn revoke_api_key_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let bearer = match parse_bearer_token(&headers) {
        Some(token) => token,
        None => return error_response(StatusCode::UNAUTHORIZED, "missing bearer token"),
    };
    let owner_did = ensure_owner_for_api_token(&state, &bearer).await;
    let mut inner = state.inner.lock().await;
    let token_to_remove = {
        let Some(record) = inner.api_keys.get_mut(id.trim()) else {
            return error_response(StatusCode::NOT_FOUND, "api key not found");
        };
        if record.owner_did != owner_did {
            return error_response(StatusCode::NOT_FOUND, "api key not found");
        }
        record.status = "revoked".to_string();
        record.token.clone()
    };
    inner.api_key_owner_by_token.remove(&token_to_remove);
    (StatusCode::NO_CONTENT, Json(json!({})))
}

pub(crate) fn create_api_key_record(
    owner_did: &str,
    name: String,
    token_override: Option<String>,
) -> ApiKeyRecord {
    ApiKeyRecord {
        id: Ulid::new().to_string(),
        owner_did: owner_did.to_string(),
        name,
        status: "active".to_string(),
        created_at: Utc::now().to_rfc3339(),
        last_used_at: None,
        token: token_override
            .unwrap_or_else(|| format!("pat_{}", Ulid::new().to_string().to_lowercase())),
    }
}

pub(crate) fn insert_api_key(inner: &mut InnerState, record: ApiKeyRecord) {
    inner
        .api_key_owner_by_token
        .insert(record.token.clone(), record.owner_did.clone());
    inner
        .api_keys_by_owner
        .entry(record.owner_did.clone())
        .or_default()
        .push(record.id.clone());
    inner.api_keys.insert(record.id.clone(), record);
}

pub(crate) async fn ensure_owner_for_api_token(state: &AppState, token: &str) -> String {
    let mut inner = state.inner.lock().await;
    if let Some(owner_did) = inner.api_key_owner_by_token.get(token) {
        return owner_did.clone();
    }

    let owner_did = make_human_did();
    let bootstrap_key =
        create_api_key_record(&owner_did, "bootstrap".to_string(), Some(token.to_string()));
    insert_api_key(&mut inner, bootstrap_key);
    owner_did
}
