use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::{Json, response::Response};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{Duration, Utc};
use clawdentity_core::{X_CLAW_BODY_SHA256, X_CLAW_NONCE, X_CLAW_PROOF, X_CLAW_TIMESTAMP};
use serde_json::{Value, json};
use ulid::Ulid;

use crate::state::{
    AppState, PAIRING_TICKET_PREFIX, PairConfirmRequest, PairProfile, PairStartRequest,
    PairStatusRequest, PairingRecord,
};

pub async fn pair_start_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PairStartRequest>,
) -> impl IntoResponse {
    let agent_did = match authenticate_claw_headers(&headers) {
        Ok(agent_did) => agent_did,
        Err(response) => return response,
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

    let mut pairings = state.pairings.lock().await;
    pairings.insert(ticket.clone(), pairing);
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

pub async fn pair_confirm_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PairConfirmRequest>,
) -> impl IntoResponse {
    let responder_agent_did = match authenticate_claw_headers(&headers) {
        Ok(agent_did) => agent_did,
        Err(response) => return response,
    };
    let Some(responder_profile) = normalize_profile(body.responder_profile) else {
        return error_response(StatusCode::BAD_REQUEST, "responderProfile is invalid");
    };

    let mut pairings = state.pairings.lock().await;
    let Some(pairing) = pairings.get_mut(body.ticket.trim()) else {
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

pub async fn pair_status_post_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PairStatusRequest>,
) -> impl IntoResponse {
    if authenticate_claw_headers(&headers).is_err() {
        return error_response(StatusCode::UNAUTHORIZED, "missing or invalid claw auth headers");
    }
    pair_status_for_ticket(state, body.ticket.trim().to_string()).await
}

pub async fn pair_status_get_handler(
    State(state): State<AppState>,
    Path(ticket): Path<String>,
) -> impl IntoResponse {
    pair_status_for_ticket(state, ticket).await
}

async fn pair_status_for_ticket(state: AppState, ticket: String) -> (StatusCode, Json<Value>) {
    let pairings = state.pairings.lock().await;
    let Some(pairing) = pairings.get(ticket.trim()) else {
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

pub(crate) fn authenticate_claw_headers(
    headers: &HeaderMap,
) -> Result<String, (StatusCode, Json<Value>)> {
    let token = parse_claw_token(headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "missing claw token"))?;

    for header_name in [
        X_CLAW_TIMESTAMP,
        X_CLAW_NONCE,
        X_CLAW_BODY_SHA256,
        X_CLAW_PROOF,
    ] {
        let present = headers
            .get(header_name)
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_some();
        if !present {
            return Err(error_response(
                StatusCode::UNAUTHORIZED,
                &format!("missing {header_name}"),
            ));
        }
    }

    parse_agent_did_from_ait(&token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "invalid claw token"))
}

pub(crate) fn parse_claw_token(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get("authorization")?.to_str().ok()?;
    let candidate = raw.trim();
    if !candidate.starts_with("Claw ") {
        return None;
    }
    let token = candidate["Claw ".len()..].trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

pub(crate) fn parse_agent_did_from_ait(token: &str) -> Option<String> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() < 2 {
        return None;
    }
    let payload = URL_SAFE_NO_PAD.decode(parts[1]).ok()?;
    let value: Value = serde_json::from_slice(&payload).ok()?;
    value.get("sub")?.as_str().map(|value| value.to_string())
}

fn normalize_profile(profile: PairProfile) -> Option<PairProfile> {
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

fn make_pairing_ticket(proxy_url: &str, agent_did: &str) -> String {
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

pub(crate) fn to_response(tuple: (StatusCode, Json<Value>)) -> Response {
    tuple.into_response()
}
