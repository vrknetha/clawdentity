use std::path::PathBuf;

use thiserror::Error;

pub type Result<T> = std::result::Result<T, CoreError>;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("unable to resolve home directory")]
    HomeDirectoryUnavailable,
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("invalid url for {context}: {value}")]
    InvalidUrl {
        context: &'static str,
        value: String,
    },
    #[error("invalid config key: {0}")]
    InvalidConfigKey(String),
    #[error("identity already exists at {0}")]
    IdentityAlreadyExists(PathBuf),
    #[error("identity is not initialized at {0}")]
    IdentityNotFound(PathBuf),
    #[error("base64 decode failed: {0}")]
    Base64Decode(String),
    #[error("http request failed: {0}")]
    Http(String),
    #[error("unexpected http status {status}: {message}")]
    HttpStatus { status: u16, message: String },
    #[error("io error at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to parse json at {path}: {source}")]
    JsonParse {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("failed to parse json5 at {path}: {message}")]
    Json5Parse { path: PathBuf, message: String },
    #[error("failed to serialize json: {0}")]
    JsonSerialize(#[from] serde_json::Error),
    #[error("command failed: {command}: {message}")]
    CommandFailed { command: String, message: String },
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
}
