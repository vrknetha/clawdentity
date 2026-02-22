use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::routing::{get, post};
use tokio::sync::Mutex;

mod pairing;
mod relay;
mod state;

use state::{AppState, DEFAULT_PROXY_PORT};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let port = std::env::var("MOCK_PROXY_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PROXY_PORT);
    let proxy_url = std::env::var("MOCK_PROXY_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("http://127.0.0.1:{port}"));
    let state = AppState {
        proxy_url,
        routes: Arc::new(Mutex::new(HashMap::new())),
        queued: Arc::new(Mutex::new(HashMap::new())),
        pairings: Arc::new(Mutex::new(HashMap::new())),
    };

    let app = Router::new()
        .route("/health", get(relay::health_handler))
        .route("/v1/relay/connect", get(relay::relay_connect_handler))
        .route("/v1/relay/deliver", post(relay::relay_deliver_handler))
        .route("/pair/start", post(pairing::pair_start_handler))
        .route("/pair/confirm", post(pairing::pair_confirm_handler))
        .route("/pair/status", post(pairing::pair_status_post_handler))
        .route("/pair/status/{ticket}", get(pairing::pair_status_get_handler))
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    eprintln!("mock-proxy listening on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
