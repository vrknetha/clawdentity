use rusqlite::{params, types::Type};

use crate::db::{SqliteStore, now_utc_ms};
use crate::error::{CoreError, Result};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerRecord {
    pub alias: String,
    pub did: String,
    pub proxy_url: String,
    pub agent_name: Option<String>,
    pub human_name: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpsertPeerInput {
    pub alias: String,
    pub did: String,
    pub proxy_url: String,
    pub agent_name: Option<String>,
    pub human_name: Option<String>,
}

fn invalid_data_error(message: impl Into<String>) -> CoreError {
    CoreError::InvalidInput(message.into())
}

fn parse_optional_non_empty(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn map_peer_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PeerRecord> {
    Ok(PeerRecord {
        alias: row.get(0)?,
        did: row.get(1)?,
        proxy_url: row.get(2)?,
        agent_name: row.get(3)?,
        human_name: row.get(4)?,
        created_at_ms: row.get(5)?,
        updated_at_ms: row.get(6)?,
    })
}

/// TODO(clawdentity): document `upsert_peer`.
pub fn upsert_peer(store: &SqliteStore, input: UpsertPeerInput) -> Result<PeerRecord> {
    let alias = input.alias.trim().to_string();
    let did = input.did.trim().to_string();
    let proxy_url = input.proxy_url.trim().to_string();
    if alias.is_empty() {
        return Err(invalid_data_error("peer alias is required"));
    }
    if did.is_empty() {
        return Err(invalid_data_error("peer did is required"));
    }
    if proxy_url.is_empty() {
        return Err(invalid_data_error("peer proxyUrl is required"));
    }

    let agent_name = parse_optional_non_empty(input.agent_name);
    let human_name = parse_optional_non_empty(input.human_name);
    let now_ms = now_utc_ms();

    store.with_connection(|connection| {
        connection.execute(
            "INSERT INTO peers (
                alias, did, proxy_url, agent_name, human_name, created_at_ms, updated_at_ms
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
            ON CONFLICT(alias) DO UPDATE SET
                did = excluded.did,
                proxy_url = excluded.proxy_url,
                agent_name = excluded.agent_name,
                human_name = excluded.human_name,
                updated_at_ms = excluded.updated_at_ms",
            params![&alias, &did, &proxy_url, &agent_name, &human_name, now_ms],
        )?;

        get_peer(connection, &alias).ok_or_else(|| {
            CoreError::Sqlite(rusqlite::Error::FromSqlConversionFailure(
                0,
                Type::Text,
                "upsert_peer lost row".into(),
            ))
        })
    })
}

/// TODO(clawdentity): document `get_peer_by_alias`.
pub fn get_peer_by_alias(store: &SqliteStore, alias: &str) -> Result<Option<PeerRecord>> {
    let alias = alias.trim().to_string();
    if alias.is_empty() {
        return Ok(None);
    }
    store.with_connection(|connection| Ok(get_peer(connection, &alias)))
}

fn get_peer(connection: &rusqlite::Connection, alias: &str) -> Option<PeerRecord> {
    let mut statement = connection
        .prepare(
            "SELECT alias, did, proxy_url, agent_name, human_name, created_at_ms, updated_at_ms
            FROM peers WHERE alias = ?1",
        )
        .ok()?;
    statement.query_row([alias], map_peer_row).ok()
}

/// TODO(clawdentity): document `list_peers`.
pub fn list_peers(store: &SqliteStore) -> Result<Vec<PeerRecord>> {
    store.with_connection(|connection| {
        let mut statement = connection.prepare(
            "SELECT alias, did, proxy_url, agent_name, human_name, created_at_ms, updated_at_ms
             FROM peers
             ORDER BY alias ASC",
        )?;
        let rows = statement.query_map([], map_peer_row)?;
        let peers: rusqlite::Result<Vec<PeerRecord>> = rows.collect();
        Ok(peers?)
    })
}

/// TODO(clawdentity): document `delete_peer`.
pub fn delete_peer(store: &SqliteStore, alias: &str) -> Result<bool> {
    let alias = alias.trim().to_string();
    if alias.is_empty() {
        return Ok(false);
    }
    store.with_connection(|connection| {
        let deleted = connection.execute("DELETE FROM peers WHERE alias = ?1", [alias])?;
        Ok(deleted > 0)
    })
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use crate::db::SqliteStore;

    use super::{UpsertPeerInput, delete_peer, get_peer_by_alias, list_peers, upsert_peer};

    #[test]
    fn upsert_list_get_delete_peer_records() {
        let temp = TempDir::new().expect("temp dir");
        let store = SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("open db");

        let inserted = upsert_peer(
            &store,
            UpsertPeerInput {
                alias: "alpha".to_string(),
                did: "did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4".to_string(),
                proxy_url: "https://proxy.example".to_string(),
                agent_name: Some("Alpha".to_string()),
                human_name: Some("Alice".to_string()),
            },
        )
        .expect("insert peer");
        assert_eq!(inserted.alias, "alpha");

        let fetched = get_peer_by_alias(&store, "alpha")
            .expect("get peer")
            .expect("peer");
        assert_eq!(fetched.did, "did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4");

        let listed = list_peers(&store).expect("list peers");
        assert_eq!(listed.len(), 1);

        let deleted = delete_peer(&store, "alpha").expect("delete peer");
        assert!(deleted);
        assert!(
            get_peer_by_alias(&store, "alpha")
                .expect("get deleted")
                .is_none()
        );
    }
}
