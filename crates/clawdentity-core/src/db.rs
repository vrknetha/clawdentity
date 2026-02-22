use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rusqlite::{Connection, OptionalExtension, params};

use crate::config::{ConfigPathOptions, get_config_dir};
use crate::error::{CoreError, Result};

pub const SQLITE_FILE_NAME: &str = "clawdentity.sqlite3";

const MIGRATION_NAME_PHASE3: &str = "0001_phase3_persistence_model";
const MIGRATION_SQL_PHASE3: &str = r#"
CREATE TABLE IF NOT EXISTS peers (
    alias TEXT PRIMARY KEY,
    did TEXT NOT NULL,
    proxy_url TEXT NOT NULL,
    agent_name TEXT,
    human_name TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS outbound_queue (
    frame_id TEXT PRIMARY KEY,
    frame_version INTEGER NOT NULL,
    frame_type TEXT NOT NULL,
    to_agent_did TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    conversation_id TEXT,
    reply_to TEXT,
    created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS inbound_pending (
    request_id TEXT PRIMARY KEY,
    frame_id TEXT NOT NULL,
    from_agent_did TEXT NOT NULL,
    to_agent_did TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    payload_bytes INTEGER NOT NULL,
    received_at_ms INTEGER NOT NULL,
    next_attempt_at_ms INTEGER NOT NULL,
    attempt_count INTEGER NOT NULL,
    last_error TEXT,
    last_attempt_at_ms INTEGER,
    conversation_id TEXT,
    reply_to TEXT
);

CREATE TABLE IF NOT EXISTS inbound_dead_letter (
    request_id TEXT PRIMARY KEY,
    frame_id TEXT NOT NULL,
    from_agent_did TEXT NOT NULL,
    to_agent_did TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    payload_bytes INTEGER NOT NULL,
    received_at_ms INTEGER NOT NULL,
    attempt_count INTEGER NOT NULL,
    last_error TEXT,
    last_attempt_at_ms INTEGER,
    conversation_id TEXT,
    reply_to TEXT,
    dead_lettered_at_ms INTEGER NOT NULL,
    dead_letter_reason TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inbound_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at_ms INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    request_id TEXT,
    details_json TEXT
);

CREATE TABLE IF NOT EXISTS verify_cache (
    cache_key TEXT PRIMARY KEY,
    registry_url TEXT NOT NULL,
    fetched_at_ms INTEGER NOT NULL,
    payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outbound_created_at_ms
    ON outbound_queue(created_at_ms);
CREATE INDEX IF NOT EXISTS idx_inbound_pending_next_attempt
    ON inbound_pending(next_attempt_at_ms);
CREATE INDEX IF NOT EXISTS idx_inbound_dead_letter_dead_lettered_at
    ON inbound_dead_letter(dead_lettered_at_ms);
CREATE INDEX IF NOT EXISTS idx_verify_cache_fetched_at_ms
    ON verify_cache(fetched_at_ms);
"#;

#[derive(Clone)]
pub struct SqliteStore {
    connection: Arc<Mutex<Connection>>,
    path: PathBuf,
}

impl SqliteStore {
    pub fn open(options: &ConfigPathOptions) -> Result<Self> {
        let path = get_config_dir(options)?.join(SQLITE_FILE_NAME);
        Self::open_path(path)
    }

    pub fn open_path(path: impl Into<PathBuf>) -> Result<Self> {
        let path = path.into();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|source| CoreError::Io {
                path: parent.to_path_buf(),
                source,
            })?;
        }

        let connection = Connection::open(&path)?;
        configure_connection(&connection)?;
        apply_migrations(&connection)?;

        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
            path,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn with_connection<T>(
        &self,
        operation: impl FnOnce(&Connection) -> Result<T>,
    ) -> Result<T> {
        let guard = self.connection.lock().map_err(|_| {
            CoreError::InvalidInput("sqlite connection lock is poisoned".to_string())
        })?;
        operation(&guard)
    }
}

pub fn now_utc_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn configure_connection(connection: &Connection) -> Result<()> {
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    Ok(())
}

fn apply_migrations(connection: &Connection) -> Result<()> {
    tracing::info!(migration = MIGRATION_NAME_PHASE3, "checking database migrations");
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            name TEXT PRIMARY KEY,
            applied_at_ms INTEGER NOT NULL
        );",
    )?;

    let already_applied: Option<String> = connection
        .query_row(
            "SELECT name FROM schema_migrations WHERE name = ?1",
            [MIGRATION_NAME_PHASE3],
            |row| row.get(0),
        )
        .optional()?;
    if already_applied.is_some() {
        tracing::info!(migration = MIGRATION_NAME_PHASE3, "database migration already applied");
        return Ok(());
    }

    tracing::info!(migration = MIGRATION_NAME_PHASE3, "applying database migration");
    connection.execute_batch(MIGRATION_SQL_PHASE3)?;
    connection.execute(
        "INSERT INTO schema_migrations (name, applied_at_ms) VALUES (?1, ?2)",
        params![MIGRATION_NAME_PHASE3, now_utc_ms()],
    )?;
    tracing::info!(migration = MIGRATION_NAME_PHASE3, "database migration applied");
    Ok(())
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::SqliteStore;

    #[test]
    fn opens_database_and_applies_phase3_schema() {
        let temp = TempDir::new().expect("temp dir");
        let db = SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("open db");

        db.with_connection(|connection| {
            let table_count: i64 = connection.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN (
                    'peers',
                    'outbound_queue',
                    'inbound_pending',
                    'inbound_dead_letter',
                    'inbound_events',
                    'verify_cache',
                    'schema_migrations'
                )",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(table_count, 7);
            Ok(())
        })
        .expect("schema query");
    }
}
