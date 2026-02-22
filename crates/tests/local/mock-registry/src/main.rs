mod agent;
mod api_keys;
mod crypto;
mod identity;
mod invites;
mod pairing;
mod state;

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use chrono::Utc;
use serde_json::json;
use tokio::sync::Mutex;
use ulid::Ulid;

use crate::agent::{
    get_agent_challenge_handler, post_agent_challenge_handler, refresh_agent_auth_handler,
    register_agent_handler,
};
use crate::api_keys::{create_api_key_handler, list_api_keys_handler, revoke_api_key_handler};
use crate::crypto::{generate_signing_material, sign_jwt};
use crate::identity::{admin_bootstrap_handler, register_identity_handler};
use crate::invites::{create_invite_handler, redeem_invite_handler};
use crate::pairing::{
    pair_confirm_handler, pair_start_handler, pair_status_get_handler, pair_status_post_handler,
};
use crate::state::{error_response, AppState, InnerState};

const DEFAULT_REGISTRY_PORT: u16 = 13370;
const DEFAULT_PROXY_URL: &str = "http://127.0.0.1:13371";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let port = std::env::var("MOCK_REGISTRY_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_REGISTRY_PORT);
    let registry_url = std::env::var("MOCK_REGISTRY_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("http://127.0.0.1:{port}"));
    let proxy_url = std::env::var("MOCK_PROXY_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_PROXY_URL.to_string());

    let signing = Arc::new(generate_signing_material()?);
    let state = AppState {
        registry_url,
        proxy_url,
        signing,
        inner: Arc::new(Mutex::new(InnerState::default())),
    };

    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/v1/metadata", get(metadata_handler))
        .route(
            "/.well-known/claw-registry.json",
            get(well_known_registry_handler),
        )
        .route("/.well-known/claw-keys.json", get(well_known_keys_handler))
        .route("/v1/identities", post(register_identity_handler))
        .route("/v1/admin/bootstrap", post(admin_bootstrap_handler))
        .route(
            "/v1/agents/challenge",
            get(get_agent_challenge_handler).post(post_agent_challenge_handler),
        )
        .route("/v1/agents", post(register_agent_handler))
        .route("/v1/agents/auth/refresh", post(refresh_agent_auth_handler))
        .route("/v1/crl", get(crl_handler))
        .route(
            "/v1/me/api-keys",
            get(list_api_keys_handler).post(create_api_key_handler),
        )
        .route("/v1/me/api-keys/{id}", delete(revoke_api_key_handler))
        .route(
            "/v1/api-keys",
            get(list_api_keys_handler).post(create_api_key_handler),
        )
        .route("/v1/api-keys/{id}", delete(revoke_api_key_handler))
        .route("/v1/invites", post(create_invite_handler))
        .route("/v1/invites/redeem", post(redeem_invite_handler))
        .route("/pair/start", post(pair_start_handler))
        .route("/pair/confirm", post(pair_confirm_handler))
        .route("/pair/status", post(pair_status_post_handler))
        .route("/pair/status/{ticket}", get(pair_status_get_handler))
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    eprintln!("mock-registry listening on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health_handler() -> impl IntoResponse {
    (StatusCode::OK, Json(json!({ "status": "ok" })))
}

async fn metadata_handler(State(state): State<AppState>) -> impl IntoResponse {
    (
        StatusCode::OK,
        Json(json!({
            "registryUrl": state.registry_url,
            "proxyUrl": state.proxy_url,
        })),
    )
}

async fn well_known_registry_handler(State(state): State<AppState>) -> impl IntoResponse {
    (
        StatusCode::OK,
        Json(json!({
            "registryUrl": state.registry_url,
            "proxyUrl": state.proxy_url,
            "registry_url": state.registry_url,
            "proxy_url": state.proxy_url,
        })),
    )
}

async fn well_known_keys_handler(State(state): State<AppState>) -> impl IntoResponse {
    (
        StatusCode::OK,
        Json(json!({
            "keys": [{
                "kid": state.signing.kid,
                "alg": "EdDSA",
                "crv": "Ed25519",
                "x": state.signing.public_key_x,
                "status": "active",
            }],
        })),
    )
}

async fn crl_handler(State(state): State<AppState>) -> impl IntoResponse {
    let now_ts = Utc::now().timestamp();
    let payload = json!({
        "iss": state.registry_url,
        "jti": Ulid::new().to_string(),
        "iat": now_ts,
        "exp": now_ts + 3600,
        "revocations": [],
    });
    let token = match sign_jwt(&state.signing, &payload) {
        Ok(token) => token,
        Err(message) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, &message),
    };
    (StatusCode::OK, Json(json!({ "crl": token })))
}
