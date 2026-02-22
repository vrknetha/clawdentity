//! Shared HTTP client helpers with a default request timeout.

use std::time::Duration;

use crate::error::{CoreError, Result};

pub const HTTP_TIMEOUT_SECONDS: u64 = 30;

pub fn blocking_client() -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECONDS))
        .build()
        .map_err(|error| CoreError::Http(error.to_string()))
}

pub fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECONDS))
        .build()
        .map_err(|error| CoreError::Http(error.to_string()))
}
