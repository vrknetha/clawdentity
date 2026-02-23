use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use chrono::{Duration, Utc};
use serde_json::{Value, json};
use ulid::Ulid;

use crate::api_keys::ensure_owner_for_api_token;
use crate::crypto::{
    make_agent_did, parse_agent_did_from_ait, parse_bearer_token, parse_claw_token, random_b64url,
    sign_jwt,
};
use crate::state::{
    AgentAuthRefreshRequest, AgentChallengeRequest, AgentRecord, AgentRegisterRequest, AppState,
    ChallengeRecord, error_response,
};

pub(crate) async fn get_agent_challenge_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    create_agent_challenge_response(state, headers, None).await
}

pub(crate) async fn post_agent_challenge_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<AgentChallengeRequest>,
) -> impl IntoResponse {
    create_agent_challenge_response(state, headers, body.public_key).await
}

pub(crate) async fn create_agent_challenge_response(
    state: AppState,
    headers: HeaderMap,
    public_key: Option<String>,
) -> (StatusCode, Json<Value>) {
    let bearer = match parse_bearer_token(&headers) {
        Some(token) => token,
        None => return error_response(StatusCode::UNAUTHORIZED, "missing bearer token"),
    };
    let owner_did = ensure_owner_for_api_token(&state, &bearer).await;
    let challenge_id = Ulid::new().to_string();
    let nonce = random_b64url(16).unwrap_or_else(|| Ulid::new().to_string());
    let record = ChallengeRecord {
        owner_did: owner_did.clone(),
        public_key: public_key.unwrap_or_default(),
    };

    let mut inner = state.inner.lock().await;
    inner.challenges.insert(challenge_id.clone(), record);
    (
        StatusCode::OK,
        Json(json!({
            "challengeId": challenge_id,
            "nonce": nonce,
            "ownerDid": owner_did,
            "expiresAt": (Utc::now() + Duration::minutes(10)).to_rfc3339(),
            "algorithm": "Ed25519",
            "messageTemplate": "clawdentity.register.v1",
        })),
    )
}

pub(crate) async fn register_agent_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<AgentRegisterRequest>,
) -> impl IntoResponse {
    if parse_bearer_token(&headers).is_none() {
        return error_response(StatusCode::UNAUTHORIZED, "missing bearer token");
    }
    if body.name.trim().is_empty()
        || body.public_key.trim().is_empty()
        || body.challenge_id.trim().is_empty()
        || body.challenge_signature.trim().is_empty()
    {
        return error_response(
            StatusCode::BAD_REQUEST,
            "invalid agent registration payload",
        );
    }

    let mut inner = state.inner.lock().await;
    let challenge = match inner.challenges.remove(body.challenge_id.trim()) {
        Some(challenge) => challenge,
        None => return error_response(StatusCode::BAD_REQUEST, "invalid challenge"),
    };
    if !challenge.public_key.trim().is_empty()
        && challenge.public_key.trim() != body.public_key.trim()
    {
        return error_response(StatusCode::BAD_REQUEST, "challenge public key mismatch");
    }

    let framework = body
        .framework
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("openclaw")
        .to_string();
    let ttl_days = body.ttl_days.unwrap_or(30).max(1);
    let exp_ts = (Utc::now() + Duration::days(i64::from(ttl_days))).timestamp();
    let expires_at = chrono::DateTime::<chrono::Utc>::from_timestamp(exp_ts, 0)
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_else(|| (Utc::now() + Duration::days(30)).to_rfc3339());
    let agent_did = make_agent_did(&state.registry_url);

    let ait_payload = json!({
        "iss": state.registry_url,
        "sub": agent_did,
        "ownerDid": challenge.owner_did,
        "jti": Ulid::new().to_string(),
        "iat": Utc::now().timestamp(),
        "exp": exp_ts,
        "framework": framework,
        "cnf": {
            "jwk": {
                "kty": "OKP",
                "crv": "Ed25519",
                "x": body.public_key.trim(),
            }
        }
    });
    let ait = match sign_jwt(&state.signing, &ait_payload) {
        Ok(token) => token,
        Err(message) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, &message),
    };

    let access_token = format!("clw_agt_access_{}", Ulid::new());
    let refresh_token = format!("clw_rft_refresh_{}", Ulid::new());
    let access_expires_at = (Utc::now() + Duration::hours(1)).to_rfc3339();
    let refresh_expires_at = (Utc::now() + Duration::days(14)).to_rfc3339();

    inner.agents.insert(
        agent_did.clone(),
        AgentRecord {
            did: agent_did.clone(),
            owner_did: challenge.owner_did.clone(),
        },
    );
    inner
        .refresh_tokens
        .insert(refresh_token.clone(), agent_did.clone());

    (
        StatusCode::CREATED,
        Json(json!({
            "agent": {
                "did": agent_did,
                "name": body.name.trim(),
                "framework": framework,
                "expiresAt": expires_at,
            },
            "ait": ait,
            "agentAuth": {
                "tokenType": "Bearer",
                "accessToken": access_token,
                "accessExpiresAt": access_expires_at,
                "refreshToken": refresh_token,
                "refreshExpiresAt": refresh_expires_at,
            }
        })),
    )
}

pub(crate) async fn refresh_agent_auth_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<AgentAuthRefreshRequest>,
) -> impl IntoResponse {
    let claw_token = match parse_claw_token(&headers) {
        Some(token) => token,
        None => return error_response(StatusCode::UNAUTHORIZED, "missing claw token"),
    };
    if body.refresh_token.trim().is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "refreshToken is required");
    }

    let mut inner = state.inner.lock().await;
    let agent_did = inner
        .refresh_tokens
        .remove(body.refresh_token.trim())
        .or_else(|| parse_agent_did_from_ait(&claw_token));
    if let Some(agent_did) = &agent_did
        && let Some(agent) = inner.agents.get(agent_did)
    {
        let _ = (&agent.did, &agent.owner_did);
    }
    let Some(agent_did) = agent_did else {
        return error_response(StatusCode::BAD_REQUEST, "invalid refreshToken");
    };

    let access_token = format!("clw_agt_access_{}", Ulid::new());
    let refresh_token = format!("clw_rft_refresh_{}", Ulid::new());
    inner
        .refresh_tokens
        .insert(refresh_token.clone(), agent_did);
    (
        StatusCode::OK,
        Json(json!({
            "agentAuth": {
                "tokenType": "Bearer",
                "accessToken": access_token,
                "accessExpiresAt": (Utc::now() + Duration::hours(1)).to_rfc3339(),
                "refreshToken": refresh_token,
                "refreshExpiresAt": (Utc::now() + Duration::days(14)).to_rfc3339(),
            }
        })),
    )
}
