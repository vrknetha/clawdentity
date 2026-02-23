use rusqlite::params;

use crate::db::{SqliteStore, now_utc_ms};
use crate::error::{CoreError, Result};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboundQueueItem {
    pub frame_id: String,
    pub frame_version: i64,
    pub frame_type: String,
    pub to_agent_did: String,
    pub payload_json: String,
    pub conversation_id: Option<String>,
    pub reply_to: Option<String>,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboundDeadLetterItem {
    pub frame_id: String,
    pub frame_version: i64,
    pub frame_type: String,
    pub to_agent_did: String,
    pub payload_json: String,
    pub conversation_id: Option<String>,
    pub reply_to: Option<String>,
    pub created_at_ms: i64,
    pub dead_lettered_at_ms: i64,
    pub dead_letter_reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnqueueOutboundInput {
    pub frame_id: String,
    pub frame_version: i64,
    pub frame_type: String,
    pub to_agent_did: String,
    pub payload_json: String,
    pub conversation_id: Option<String>,
    pub reply_to: Option<String>,
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

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<OutboundQueueItem> {
    Ok(OutboundQueueItem {
        frame_id: row.get(0)?,
        frame_version: row.get(1)?,
        frame_type: row.get(2)?,
        to_agent_did: row.get(3)?,
        payload_json: row.get(4)?,
        conversation_id: row.get(5)?,
        reply_to: row.get(6)?,
        created_at_ms: row.get(7)?,
    })
}

fn map_dead_letter_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<OutboundDeadLetterItem> {
    Ok(OutboundDeadLetterItem {
        frame_id: row.get(0)?,
        frame_version: row.get(1)?,
        frame_type: row.get(2)?,
        to_agent_did: row.get(3)?,
        payload_json: row.get(4)?,
        conversation_id: row.get(5)?,
        reply_to: row.get(6)?,
        created_at_ms: row.get(7)?,
        dead_lettered_at_ms: row.get(8)?,
        dead_letter_reason: row.get(9)?,
    })
}

pub fn enqueue_outbound(store: &SqliteStore, input: EnqueueOutboundInput) -> Result<()> {
    let frame_id = input.frame_id.trim().to_string();
    let frame_type = input.frame_type.trim().to_string();
    let to_agent_did = input.to_agent_did.trim().to_string();
    let payload_json = input.payload_json.trim().to_string();

    if frame_id.is_empty() {
        return Err(CoreError::InvalidInput("frame_id is required".to_string()));
    }
    if frame_type.is_empty() {
        return Err(CoreError::InvalidInput(
            "frame_type is required".to_string(),
        ));
    }
    if to_agent_did.is_empty() {
        return Err(CoreError::InvalidInput(
            "to_agent_did is required".to_string(),
        ));
    }
    if payload_json.is_empty() {
        return Err(CoreError::InvalidInput(
            "payload_json is required".to_string(),
        ));
    }

    let conversation_id = parse_optional_non_empty(input.conversation_id);
    let reply_to = parse_optional_non_empty(input.reply_to);
    let created_at_ms = now_utc_ms();
    store.with_connection(|connection| {
        connection.execute(
            "INSERT INTO outbound_queue (
                frame_id, frame_version, frame_type, to_agent_did, payload_json, conversation_id, reply_to, created_at_ms
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                frame_id,
                input.frame_version,
                frame_type,
                to_agent_did,
                payload_json,
                conversation_id,
                reply_to,
                created_at_ms
            ],
        )?;
        Ok(())
    })
}

pub fn list_outbound(store: &SqliteStore, limit: usize) -> Result<Vec<OutboundQueueItem>> {
    let limit = i64::try_from(limit).unwrap_or(i64::MAX);
    store.with_connection(|connection| {
        let mut statement = connection.prepare(
            "SELECT frame_id, frame_version, frame_type, to_agent_did, payload_json, conversation_id, reply_to, created_at_ms
             FROM outbound_queue
             ORDER BY created_at_ms ASC, frame_id ASC
             LIMIT ?1",
        )?;
        let rows = statement.query_map([limit], map_row)?;
        let items: rusqlite::Result<Vec<OutboundQueueItem>> = rows.collect();
        Ok(items?)
    })
}

pub fn take_oldest_outbound(store: &SqliteStore) -> Result<Option<OutboundQueueItem>> {
    store.with_connection(|connection| {
        let mut statement = connection.prepare(
            "SELECT frame_id, frame_version, frame_type, to_agent_did, payload_json, conversation_id, reply_to, created_at_ms
             FROM outbound_queue
             ORDER BY created_at_ms ASC, frame_id ASC
             LIMIT 1",
        )?;
        let item = statement.query_row([], map_row).ok();
        let Some(item) = item else {
            return Ok(None);
        };
        connection.execute("DELETE FROM outbound_queue WHERE frame_id = ?1", [&item.frame_id])?;
        Ok(Some(item))
    })
}

pub fn delete_outbound(store: &SqliteStore, frame_id: &str) -> Result<bool> {
    let frame_id = frame_id.trim();
    if frame_id.is_empty() {
        return Ok(false);
    }
    store.with_connection(|connection| {
        let affected =
            connection.execute("DELETE FROM outbound_queue WHERE frame_id = ?1", [frame_id])?;
        Ok(affected > 0)
    })
}

pub fn move_outbound_to_dead_letter(
    store: &SqliteStore,
    item: &OutboundQueueItem,
    dead_letter_reason: &str,
) -> Result<()> {
    let reason = dead_letter_reason.trim();
    if reason.is_empty() {
        return Err(CoreError::InvalidInput(
            "dead_letter_reason is required".to_string(),
        ));
    }

    let dead_lettered_at_ms = now_utc_ms();
    store.with_connection(|connection| {
        connection.execute(
            "INSERT INTO outbound_dead_letter (
                frame_id, frame_version, frame_type, to_agent_did, payload_json, conversation_id, reply_to,
                created_at_ms, dead_lettered_at_ms, dead_letter_reason
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            ON CONFLICT(frame_id) DO UPDATE SET
                frame_version = excluded.frame_version,
                frame_type = excluded.frame_type,
                to_agent_did = excluded.to_agent_did,
                payload_json = excluded.payload_json,
                conversation_id = excluded.conversation_id,
                reply_to = excluded.reply_to,
                created_at_ms = excluded.created_at_ms,
                dead_lettered_at_ms = excluded.dead_lettered_at_ms,
                dead_letter_reason = excluded.dead_letter_reason",
            params![
                &item.frame_id,
                item.frame_version,
                &item.frame_type,
                &item.to_agent_did,
                &item.payload_json,
                &item.conversation_id,
                &item.reply_to,
                item.created_at_ms,
                dead_lettered_at_ms,
                reason
            ],
        )?;
        Ok(())
    })
}

pub fn outbound_count(store: &SqliteStore) -> Result<i64> {
    store.with_connection(|connection| {
        let count =
            connection.query_row("SELECT COUNT(*) FROM outbound_queue", [], |row| row.get(0))?;
        Ok(count)
    })
}

pub fn list_outbound_dead_letter(
    store: &SqliteStore,
    limit: usize,
) -> Result<Vec<OutboundDeadLetterItem>> {
    let limit = i64::try_from(limit).unwrap_or(i64::MAX);
    store.with_connection(|connection| {
        let mut statement = connection.prepare(
            "SELECT frame_id, frame_version, frame_type, to_agent_did, payload_json, conversation_id, reply_to,
                    created_at_ms, dead_lettered_at_ms, dead_letter_reason
             FROM outbound_dead_letter
             ORDER BY dead_lettered_at_ms DESC, frame_id DESC
             LIMIT ?1",
        )?;
        let rows = statement.query_map([limit], map_dead_letter_row)?;
        let items: rusqlite::Result<Vec<OutboundDeadLetterItem>> = rows.collect();
        Ok(items?)
    })
}

pub fn outbound_dead_letter_count(store: &SqliteStore) -> Result<i64> {
    store.with_connection(|connection| {
        let count =
            connection.query_row("SELECT COUNT(*) FROM outbound_dead_letter", [], |row| {
                row.get(0)
            })?;
        Ok(count)
    })
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use crate::db::SqliteStore;

    use super::{
        EnqueueOutboundInput, delete_outbound, enqueue_outbound, list_outbound,
        list_outbound_dead_letter, move_outbound_to_dead_letter, outbound_count,
        outbound_dead_letter_count, take_oldest_outbound,
    };

    #[test]
    fn enqueue_take_and_delete_outbound_items() {
        let temp = TempDir::new().expect("temp dir");
        let store = SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("open db");

        enqueue_outbound(
            &store,
            EnqueueOutboundInput {
                frame_id: "frame-1".to_string(),
                frame_version: 1,
                frame_type: "relay.frame".to_string(),
                to_agent_did: "did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4".to_string(),
                payload_json: "{\"hello\":\"world\"}".to_string(),
                conversation_id: Some("conv-1".to_string()),
                reply_to: None,
            },
        )
        .expect("enqueue 1");
        enqueue_outbound(
            &store,
            EnqueueOutboundInput {
                frame_id: "frame-2".to_string(),
                frame_version: 1,
                frame_type: "relay.frame".to_string(),
                to_agent_did: "did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT5".to_string(),
                payload_json: "{\"hi\":\"there\"}".to_string(),
                conversation_id: None,
                reply_to: None,
            },
        )
        .expect("enqueue 2");

        assert_eq!(outbound_count(&store).expect("count"), 2);
        assert_eq!(list_outbound(&store, 10).expect("list").len(), 2);

        let oldest = take_oldest_outbound(&store).expect("take").expect("oldest");
        assert_eq!(oldest.frame_id, "frame-1");
        assert_eq!(outbound_count(&store).expect("count after take"), 1);

        let deleted = delete_outbound(&store, "frame-2").expect("delete");
        assert!(deleted);
        assert_eq!(outbound_count(&store).expect("count after delete"), 0);
    }

    #[test]
    fn moves_outbound_item_to_dead_letter() {
        let temp = TempDir::new().expect("temp dir");
        let store = SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("open db");

        enqueue_outbound(
            &store,
            EnqueueOutboundInput {
                frame_id: "frame-1".to_string(),
                frame_version: 1,
                frame_type: "relay.frame".to_string(),
                to_agent_did: "did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4".to_string(),
                payload_json: "{\"broken\":\"json\"}".to_string(),
                conversation_id: None,
                reply_to: None,
            },
        )
        .expect("enqueue");
        let item = take_oldest_outbound(&store).expect("take").expect("item");
        move_outbound_to_dead_letter(&store, &item, "malformed outbound payload").expect("move");

        assert_eq!(outbound_count(&store).expect("queue count"), 0);
        assert_eq!(
            outbound_dead_letter_count(&store).expect("dead letter count"),
            1
        );
        let dead_letters = list_outbound_dead_letter(&store, 10).expect("dead letters");
        assert_eq!(dead_letters.len(), 1);
        assert_eq!(dead_letters[0].frame_id, "frame-1");
        assert_eq!(
            dead_letters[0].dead_letter_reason,
            "malformed outbound payload"
        );
    }
}
