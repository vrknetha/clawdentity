use rusqlite::{OptionalExtension, params};

use crate::db::{SqliteStore, now_utc_ms};
use crate::error::{CoreError, Result};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifyCacheEntry {
    pub cache_key: String,
    pub registry_url: String,
    pub fetched_at_ms: i64,
    pub payload_json: String,
}

pub fn upsert_verify_cache_entry(
    store: &SqliteStore,
    cache_key: &str,
    registry_url: &str,
    payload_json: &str,
) -> Result<()> {
    let cache_key = cache_key.trim();
    let registry_url = registry_url.trim();
    let payload_json = payload_json.trim();
    if cache_key.is_empty() {
        return Err(CoreError::InvalidInput("cache_key is required".to_string()));
    }
    if registry_url.is_empty() {
        return Err(CoreError::InvalidInput(
            "registry_url is required".to_string(),
        ));
    }
    if payload_json.is_empty() {
        return Err(CoreError::InvalidInput(
            "payload_json is required".to_string(),
        ));
    }

    let fetched_at_ms = now_utc_ms();
    store.with_connection(|connection| {
        connection.execute(
            "INSERT INTO verify_cache (cache_key, registry_url, fetched_at_ms, payload_json)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(cache_key) DO UPDATE SET
                registry_url = excluded.registry_url,
                fetched_at_ms = excluded.fetched_at_ms,
                payload_json = excluded.payload_json",
            params![cache_key, registry_url, fetched_at_ms, payload_json],
        )?;
        Ok(())
    })
}

pub fn get_verify_cache_entry(
    store: &SqliteStore,
    cache_key: &str,
) -> Result<Option<VerifyCacheEntry>> {
    let cache_key = cache_key.trim();
    if cache_key.is_empty() {
        return Ok(None);
    }

    store.with_connection(|connection| {
        let mut statement = connection.prepare(
            "SELECT cache_key, registry_url, fetched_at_ms, payload_json
             FROM verify_cache
             WHERE cache_key = ?1",
        )?;
        let result = statement
            .query_row([cache_key], |row| {
                Ok(VerifyCacheEntry {
                    cache_key: row.get(0)?,
                    registry_url: row.get(1)?,
                    fetched_at_ms: row.get(2)?,
                    payload_json: row.get(3)?,
                })
            })
            .optional()?;
        Ok(result)
    })
}

pub fn delete_verify_cache_entry(store: &SqliteStore, cache_key: &str) -> Result<bool> {
    let cache_key = cache_key.trim();
    if cache_key.is_empty() {
        return Ok(false);
    }
    store.with_connection(|connection| {
        let deleted =
            connection.execute("DELETE FROM verify_cache WHERE cache_key = ?1", [cache_key])?;
        Ok(deleted > 0)
    })
}

pub fn purge_verify_cache_before(store: &SqliteStore, cutoff_ms: i64) -> Result<usize> {
    store.with_connection(|connection| {
        let deleted = connection.execute(
            "DELETE FROM verify_cache WHERE fetched_at_ms < ?1",
            [cutoff_ms],
        )?;
        Ok(deleted)
    })
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use crate::db::SqliteStore;

    use super::{
        delete_verify_cache_entry, get_verify_cache_entry, purge_verify_cache_before,
        upsert_verify_cache_entry,
    };

    #[test]
    fn upsert_get_delete_verify_cache_entry() {
        let temp = TempDir::new().expect("temp dir");
        let store = SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("open db");

        upsert_verify_cache_entry(
            &store,
            "keys::https://registry.clawdentity.com",
            "https://registry.clawdentity.com",
            "{\"keys\":[]}",
        )
        .expect("upsert");

        let entry = get_verify_cache_entry(&store, "keys::https://registry.clawdentity.com")
            .expect("get")
            .expect("entry");
        assert_eq!(entry.registry_url, "https://registry.clawdentity.com");
        assert_eq!(entry.payload_json, "{\"keys\":[]}");

        let purged = purge_verify_cache_before(&store, i64::MAX).expect("purge");
        assert_eq!(purged, 1);
        assert!(
            get_verify_cache_entry(&store, "keys::https://registry.clawdentity.com")
                .expect("get after purge")
                .is_none()
        );

        let deleted = delete_verify_cache_entry(&store, "keys::https://registry.clawdentity.com")
            .expect("delete");
        assert!(!deleted);
    }
}
