use std::path::PathBuf;

use thiserror::Error;

pub type Result<T> = std::result::Result<T, CoreError>;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("unable to resolve home directory")]
    HomeDirectoryUnavailable,
    #[error("invalid url for {context}: {value}")]
    InvalidUrl {
        context: &'static str,
        value: String,
    },
    #[error("invalid config key: {0}")]
    InvalidConfigKey(String),
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
    #[error("failed to serialize json: {0}")]
    JsonSerialize(#[from] serde_json::Error),
}
