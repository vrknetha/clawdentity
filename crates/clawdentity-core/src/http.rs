//! Shared HTTP client helpers with a default request timeout.

use std::sync::OnceLock;
use std::time::Duration;

use crate::error::{CoreError, Result};

pub const HTTP_TIMEOUT_SECONDS: u64 = 30;
static BLOCKING_CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();

/// TODO(clawdentity): document `blocking_client`.
pub fn blocking_client() -> Result<reqwest::blocking::Client> {
    if let Some(client) = BLOCKING_CLIENT.get() {
        return Ok(client.clone());
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECONDS))
        .build()
        .map_err(|error| CoreError::Http(error.to_string()))?;
    let _ = BLOCKING_CLIENT.set(client.clone());
    Ok(client)
}

/// TODO(clawdentity): document `client`.
pub fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECONDS))
        .build()
        .map_err(|error| CoreError::Http(error.to_string()))
}
