use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use chrono::Utc;
use serde_json::json;
use ulid::Ulid;

use crate::api_keys::{create_api_key_record, ensure_owner_for_api_token, insert_api_key};
use crate::crypto::{make_human_did, parse_bearer_token};
use crate::state::{
    AppState, InviteCreateRequest, InviteRecord, InviteRedeemRequest, error_response,
};

pub(crate) async fn create_invite_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<InviteCreateRequest>,
) -> impl IntoResponse {
    let bearer = match parse_bearer_token(&headers) {
        Some(token) => token,
        None => return error_response(StatusCode::UNAUTHORIZED, "missing bearer token"),
    };
    let owner_did = ensure_owner_for_api_token(&state, &bearer).await;
    let invite = InviteRecord {
        code: format!("invite_{}", Ulid::new().to_string().to_lowercase()),
        id: Ulid::new().to_string(),
        owner_did,
        created_at: Utc::now().to_rfc3339(),
        expires_at: body.expires_at.and_then(|value| {
            let trimmed = value.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        }),
        redeemed: false,
    };
    let mut inner = state.inner.lock().await;
    inner.invites.insert(invite.code.clone(), invite.clone());
    (
        StatusCode::OK,
        Json(json!({
            "invite": {
                "code": invite.code,
                "id": invite.id,
                "createdAt": invite.created_at,
                "expiresAt": invite.expires_at,
            }
        })),
    )
}

pub(crate) async fn redeem_invite_handler(
    State(state): State<AppState>,
    Json(body): Json<InviteRedeemRequest>,
) -> impl IntoResponse {
    if body.code.trim().is_empty() || body.display_name.trim().is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "invalid invite redeem payload");
    }

    let mut inner = state.inner.lock().await;
    let Some(invite) = inner.invites.get_mut(body.code.trim()) else {
        return error_response(StatusCode::NOT_FOUND, "invite not found");
    };
    let _ = &invite.owner_did;
    if invite.redeemed {
        return error_response(StatusCode::CONFLICT, "invite already redeemed");
    }
    invite.redeemed = true;

    let owner_did = make_human_did();
    let key_name = body
        .api_key_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("cli-onboard")
        .to_string();
    let api_key = create_api_key_record(&owner_did, key_name, None);
    insert_api_key(&mut inner, api_key.clone());

    (
        StatusCode::OK,
        Json(json!({
            "apiKey": {
                "id": api_key.id,
                "name": api_key.name,
                "token": api_key.token,
            },
            "human": {
                "displayName": body.display_name.trim(),
            },
            "proxyUrl": state.proxy_url,
        })),
    )
}
