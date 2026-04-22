use rusqlite::{params, types::Type};

use crate::db::{SqliteStore, now_utc_ms};
use crate::error::{CoreError, Result};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerRecord {
    pub alias: String,
    pub did: String,
    pub proxy_url: String,
    pub agent_name: Option<String>,
    pub display_name: Option<String>,
    pub framework: Option<String>,
    pub description: Option<String>,
    pub last_synced_at_ms: Option<i64>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpsertPeerInput {
    pub alias: String,
    pub did: String,
    pub proxy_url: String,
    pub agent_name: Option<String>,
    pub display_name: Option<String>,
    pub framework: Option<String>,
    pub description: Option<String>,
    pub last_synced_at_ms: Option<i64>,
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
        display_name: row.get(4)?,
        framework: row.get(5)?,
        description: row.get(6)?,
        last_synced_at_ms: row.get(7)?,
        created_at_ms: row.get(8)?,
        updated_at_ms: row.get(9)?,
    })
}

/// TODO(clawdentity): document `upsert_peer`.
#[allow(clippy::too_many_lines)]
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
    let display_name = parse_optional_non_empty(input.display_name);
    let framework = parse_optional_non_empty(input.framework);
    let description = parse_optional_non_empty(input.description);
    let now_ms = now_utc_ms();
    let last_synced_at_ms = input.last_synced_at_ms.or(Some(now_ms));

    store.with_connection(|connection| {
        connection.execute(
            "INSERT INTO peers (
                alias, did, proxy_url, agent_name, display_name, framework, description, last_synced_at_ms, created_at_ms, updated_at_ms
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
            ON CONFLICT(alias) DO UPDATE SET
                did = excluded.did,
                proxy_url = excluded.proxy_url,
                agent_name = excluded.agent_name,
                display_name = excluded.display_name,
                framework = excluded.framework,
                description = excluded.description,
                last_synced_at_ms = excluded.last_synced_at_ms,
                updated_at_ms = excluded.updated_at_ms",
            params![
                &alias,
                &did,
                &proxy_url,
                &agent_name,
                &display_name,
                &framework,
                &description,
                &last_synced_at_ms,
                now_ms
            ],
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

/// TODO(clawdentity): document `get_peer_by_did`.
pub fn get_peer_by_did(store: &SqliteStore, did: &str) -> Result<Option<PeerRecord>> {
    let did = did.trim().to_string();
    if did.is_empty() {
        return Ok(None);
    }
    store.with_connection(|connection| Ok(get_peer_by_did_value(connection, &did)))
}

fn get_peer(connection: &rusqlite::Connection, alias: &str) -> Option<PeerRecord> {
    let mut statement = connection
        .prepare(
            "SELECT alias, did, proxy_url, agent_name, display_name, framework, description, last_synced_at_ms, created_at_ms, updated_at_ms
            FROM peers WHERE alias = ?1",
        )
        .ok()?;
    statement.query_row([alias], map_peer_row).ok()
}

fn get_peer_by_did_value(connection: &rusqlite::Connection, did: &str) -> Option<PeerRecord> {
    let mut statement = connection
        .prepare(
            "SELECT alias, did, proxy_url, agent_name, display_name, framework, description, last_synced_at_ms, created_at_ms, updated_at_ms
            FROM peers
            WHERE did = ?1
            ORDER BY updated_at_ms DESC, alias ASC
            LIMIT 1",
        )
        .ok()?;
    statement.query_row([did], map_peer_row).ok()
}

/// TODO(clawdentity): document `list_peers`.
pub fn list_peers(store: &SqliteStore) -> Result<Vec<PeerRecord>> {
    store.with_connection(|connection| {
        let mut statement = connection.prepare(
            "SELECT alias, did, proxy_url, agent_name, display_name, framework, description, last_synced_at_ms, created_at_ms, updated_at_ms
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

    use super::{
        UpsertPeerInput, delete_peer, get_peer_by_alias, get_peer_by_did, list_peers, upsert_peer,
    };

    #[test]
    fn upsert_list_get_delete_peer_records() {
        let temp = TempDir::new().expect("temp dir");
        let store = SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("open db");

        let inserted = upsert_peer(
            &store,
            UpsertPeerInput {
                alias: "alpha".to_string(),
                did: "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4"
                    .to_string(),
                proxy_url: "https://proxy.example".to_string(),
                agent_name: Some("Alpha".to_string()),
                display_name: Some("Alice".to_string()),
                framework: Some("generic".to_string()),
                description: Some("test peer".to_string()),
                last_synced_at_ms: Some(123),
            },
        )
        .expect("insert peer");
        assert_eq!(inserted.alias, "alpha");

        let fetched = get_peer_by_alias(&store, "alpha")
            .expect("get peer")
            .expect("peer");
        assert_eq!(
            fetched.did,
            "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4"
        );

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

    #[test]
    fn get_peer_by_did_returns_matching_peer() {
        let temp = TempDir::new().expect("temp dir");
        let store = SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("open db");

        upsert_peer(
            &store,
            UpsertPeerInput {
                alias: "alpha".to_string(),
                did: "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4"
                    .to_string(),
                proxy_url: "https://proxy.example".to_string(),
                agent_name: Some("Alpha".to_string()),
                display_name: Some("Alice".to_string()),
                framework: Some("generic".to_string()),
                description: Some("test peer".to_string()),
                last_synced_at_ms: Some(123),
            },
        )
        .expect("insert peer");

        let by_did = get_peer_by_did(
            &store,
            "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
        )
        .expect("get by did")
        .expect("matching peer");
        assert_eq!(by_did.alias, "alpha");
        assert_eq!(by_did.agent_name.as_deref(), Some("Alpha"));
        assert_eq!(by_did.display_name.as_deref(), Some("Alice"));
        assert_eq!(by_did.framework.as_deref(), Some("generic"));
        assert_eq!(by_did.description.as_deref(), Some("test peer"));
        assert_eq!(by_did.last_synced_at_ms, Some(123));
    }

    #[test]
    fn get_peer_by_did_returns_none_for_empty_input() {
        let temp = TempDir::new().expect("temp dir");
        let store = SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("open db");

        let by_did = get_peer_by_did(&store, "   ").expect("get by did");
        assert!(by_did.is_none());
    }

    #[test]
    fn get_peer_by_did_returns_none_when_peer_is_missing() {
        let temp = TempDir::new().expect("temp dir");
        let store = SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("open db");

        let by_did = get_peer_by_did(
            &store,
            "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
        )
        .expect("get by did");
        assert!(by_did.is_none());
    }
}
