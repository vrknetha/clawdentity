use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{Duration, Utc};
use serde_json::{json, Value};
use ulid::Ulid;

use crate::crypto::{parse_agent_did_from_ait, parse_claw_token};
use crate::state::{
    error_response, AppState, PairConfirmRequest, PairProfile, PairStartRequest, PairStatusRequest,
    PairingRecord,
};

const PAIRING_TICKET_PREFIX: &str = "clwpair1_";

pub(crate) async fn pair_start_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PairStartRequest>,
) -> impl IntoResponse {
    let claw = match parse_claw_token(&headers) {
        Some(token) => token,
        None => return error_response(StatusCode::UNAUTHORIZED, "missing claw token"),
    };
    let Some(agent_did) = parse_agent_did_from_ait(&claw) else {
        return error_response(StatusCode::UNAUTHORIZED, "invalid claw token");
    };
    let Some(initiator_profile) = normalize_profile(body.initiator_profile) else {
        return error_response(StatusCode::BAD_REQUEST, "initiatorProfile is invalid");
    };
    let ttl_seconds = body.ttl_seconds.unwrap_or(300).max(10);
    let expires_at = (Utc::now() + Duration::seconds(ttl_seconds as i64)).to_rfc3339();
    let ticket = make_pairing_ticket(&state.proxy_url, &agent_did);

    let pairing = PairingRecord {
        initiator_agent_did: agent_did.clone(),
        initiator_profile: initiator_profile.clone(),
        responder_agent_did: None,
        responder_profile: None,
        expires_at: expires_at.clone(),
        confirmed_at: None,
    };
    let mut inner = state.inner.lock().await;
    inner.pairings.insert(ticket.clone(), pairing);
    (
        StatusCode::OK,
        Json(json!({
            "ticket": ticket,
            "initiatorAgentDid": agent_did,
            "initiatorProfile": initiator_profile,
            "expiresAt": expires_at,
        })),
    )
}

pub(crate) async fn pair_confirm_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PairConfirmRequest>,
) -> impl IntoResponse {
    let claw = match parse_claw_token(&headers) {
        Some(token) => token,
        None => return error_response(StatusCode::UNAUTHORIZED, "missing claw token"),
    };
    let Some(responder_agent_did) = parse_agent_did_from_ait(&claw) else {
        return error_response(StatusCode::UNAUTHORIZED, "invalid claw token");
    };
    let Some(responder_profile) = normalize_profile(body.responder_profile) else {
        return error_response(StatusCode::BAD_REQUEST, "responderProfile is invalid");
    };

    let mut inner = state.inner.lock().await;
    let Some(pairing) = inner.pairings.get_mut(body.ticket.trim()) else {
        return error_response(StatusCode::NOT_FOUND, "ticket not found");
    };
    pairing.responder_agent_did = Some(responder_agent_did.clone());
    pairing.responder_profile = Some(responder_profile.clone());
    pairing.confirmed_at = Some(Utc::now().to_rfc3339());

    (
        StatusCode::OK,
        Json(json!({
            "paired": true,
            "initiatorAgentDid": pairing.initiator_agent_did,
            "initiatorProfile": pairing.initiator_profile,
            "responderAgentDid": responder_agent_did,
            "responderProfile": responder_profile,
        })),
    )
}

pub(crate) async fn pair_status_post_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PairStatusRequest>,
) -> impl IntoResponse {
    if parse_claw_token(&headers).is_none() {
        return error_response(StatusCode::UNAUTHORIZED, "missing claw token");
    }
    pair_status_for_ticket(state, body.ticket.trim().to_string()).await
}

pub(crate) async fn pair_status_get_handler(
    State(state): State<AppState>,
    Path(ticket): Path<String>,
) -> impl IntoResponse {
    pair_status_for_ticket(state, ticket).await
}

pub(crate) async fn pair_status_for_ticket(state: AppState, ticket: String) -> (StatusCode, Json<Value>) {
    let inner = state.inner.lock().await;
    let Some(pairing) = inner.pairings.get(ticket.trim()) else {
        return error_response(StatusCode::NOT_FOUND, "ticket not found");
    };
    let status = if pairing.responder_agent_did.is_some() {
        "confirmed"
    } else {
        "pending"
    };
    (
        StatusCode::OK,
        Json(json!({
            "status": status,
            "initiatorAgentDid": pairing.initiator_agent_did,
            "initiatorProfile": pairing.initiator_profile,
            "responderAgentDid": pairing.responder_agent_did,
            "responderProfile": pairing.responder_profile,
            "expiresAt": pairing.expires_at,
            "confirmedAt": pairing.confirmed_at,
        })),
    )
}

pub(crate) fn normalize_profile(profile: PairProfile) -> Option<PairProfile> {
    let agent_name = profile.agent_name.trim().to_string();
    let human_name = profile.human_name.trim().to_string();
    if agent_name.is_empty() || human_name.is_empty() {
        return None;
    }
    let proxy_origin = profile
        .proxy_origin
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    Some(PairProfile {
        agent_name,
        human_name,
        proxy_origin,
    })
}

pub(crate) fn make_pairing_ticket(proxy_url: &str, agent_did: &str) -> String {
    let issuer = url::Url::parse(proxy_url)
        .map(|value| value.origin().unicode_serialization())
        .unwrap_or_else(|_| proxy_url.to_string());
    let payload = json!({
        "iss": issuer,
        "sub": agent_did,
        "jti": Ulid::new().to_string(),
        "iat": Utc::now().timestamp(),
    });
    let encoded = URL_SAFE_NO_PAD.encode(payload.to_string().as_bytes());
    format!("{PAIRING_TICKET_PREFIX}{encoded}")
}
