use rusqlite::{OptionalExtension, params};
use serde::Serialize;

use crate::db::{SqliteStore, now_utc_ms};
use crate::error::{CoreError, Result};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InboundPendingItem {
    pub request_id: String,
    pub frame_id: String,
    pub from_agent_did: String,
    pub to_agent_did: String,
    pub payload_json: String,
    pub payload_bytes: i64,
    pub received_at_ms: i64,
    pub next_attempt_at_ms: i64,
    pub attempt_count: i64,
    pub last_error: Option<String>,
    pub last_attempt_at_ms: Option<i64>,
    pub conversation_id: Option<String>,
    pub reply_to: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InboundDeadLetterItem {
    pub request_id: String,
    pub frame_id: String,
    pub from_agent_did: String,
    pub to_agent_did: String,
    pub payload_json: String,
    pub payload_bytes: i64,
    pub received_at_ms: i64,
    pub attempt_count: i64,
    pub last_error: Option<String>,
    pub last_attempt_at_ms: Option<i64>,
    pub conversation_id: Option<String>,
    pub reply_to: Option<String>,
    pub dead_lettered_at_ms: i64,
    pub dead_letter_reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InboundEvent {
    pub id: i64,
    pub at_ms: i64,
    pub event_type: String,
    pub request_id: Option<String>,
    pub details_json: Option<String>,
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

fn map_pending_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<InboundPendingItem> {
    Ok(InboundPendingItem {
        request_id: row.get(0)?,
        frame_id: row.get(1)?,
        from_agent_did: row.get(2)?,
        to_agent_did: row.get(3)?,
        payload_json: row.get(4)?,
        payload_bytes: row.get(5)?,
        received_at_ms: row.get(6)?,
        next_attempt_at_ms: row.get(7)?,
        attempt_count: row.get(8)?,
        last_error: row.get(9)?,
        last_attempt_at_ms: row.get(10)?,
        conversation_id: row.get(11)?,
        reply_to: row.get(12)?,
    })
}

fn map_dead_letter_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<InboundDeadLetterItem> {
    Ok(InboundDeadLetterItem {
        request_id: row.get(0)?,
        frame_id: row.get(1)?,
        from_agent_did: row.get(2)?,
        to_agent_did: row.get(3)?,
        payload_json: row.get(4)?,
        payload_bytes: row.get(5)?,
        received_at_ms: row.get(6)?,
        attempt_count: row.get(7)?,
        last_error: row.get(8)?,
        last_attempt_at_ms: row.get(9)?,
        conversation_id: row.get(10)?,
        reply_to: row.get(11)?,
        dead_lettered_at_ms: row.get(12)?,
        dead_letter_reason: row.get(13)?,
    })
}

/// TODO(clawdentity): document `upsert_pending`.
#[allow(clippy::too_many_lines)]
pub fn upsert_pending(store: &SqliteStore, item: InboundPendingItem) -> Result<()> {
    if item.request_id.trim().is_empty() {
        return Err(CoreError::InvalidInput(
            "request_id is required".to_string(),
        ));
    }
    if item.frame_id.trim().is_empty() {
        return Err(CoreError::InvalidInput("frame_id is required".to_string()));
    }
    if item.from_agent_did.trim().is_empty() || item.to_agent_did.trim().is_empty() {
        return Err(CoreError::InvalidInput(
            "from_agent_did and to_agent_did are required".to_string(),
        ));
    }
    if item.payload_json.trim().is_empty() {
        return Err(CoreError::InvalidInput(
            "payload_json is required".to_string(),
        ));
    }
    if item.payload_bytes < 0 || item.attempt_count < 0 {
        return Err(CoreError::InvalidInput(
            "payload_bytes and attempt_count must be >= 0".to_string(),
        ));
    }

    store.with_connection(|connection| {
        connection.execute(
            "INSERT INTO inbound_pending (
                request_id, frame_id, from_agent_did, to_agent_did, payload_json, payload_bytes,
                received_at_ms, next_attempt_at_ms, attempt_count, last_error, last_attempt_at_ms,
                conversation_id, reply_to
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
            ON CONFLICT(request_id) DO UPDATE SET
                frame_id = excluded.frame_id,
                from_agent_did = excluded.from_agent_did,
                to_agent_did = excluded.to_agent_did,
                payload_json = excluded.payload_json,
                payload_bytes = excluded.payload_bytes,
                received_at_ms = excluded.received_at_ms,
                next_attempt_at_ms = excluded.next_attempt_at_ms,
                attempt_count = excluded.attempt_count,
                last_error = excluded.last_error,
                last_attempt_at_ms = excluded.last_attempt_at_ms,
                conversation_id = excluded.conversation_id,
                reply_to = excluded.reply_to",
            params![
                item.request_id.trim(),
                item.frame_id.trim(),
                item.from_agent_did.trim(),
                item.to_agent_did.trim(),
                item.payload_json.trim(),
                item.payload_bytes,
                item.received_at_ms,
                item.next_attempt_at_ms,
                item.attempt_count,
                parse_optional_non_empty(item.last_error),
                item.last_attempt_at_ms,
                parse_optional_non_empty(item.conversation_id),
                parse_optional_non_empty(item.reply_to),
            ],
        )?;
        Ok(())
    })
}

/// TODO(clawdentity): document `list_pending_due`.
pub fn list_pending_due(
    store: &SqliteStore,
    at_or_before_ms: i64,
    limit: usize,
) -> Result<Vec<InboundPendingItem>> {
    let limit = i64::try_from(limit).unwrap_or(i64::MAX);
    store.with_connection(|connection| {
        let mut statement = connection.prepare(
            "SELECT request_id, frame_id, from_agent_did, to_agent_did, payload_json, payload_bytes,
                    received_at_ms, next_attempt_at_ms, attempt_count, last_error, last_attempt_at_ms,
                    conversation_id, reply_to
             FROM inbound_pending
             WHERE next_attempt_at_ms <= ?1
             ORDER BY next_attempt_at_ms ASC, received_at_ms ASC
             LIMIT ?2",
        )?;
        let rows = statement.query_map(params![at_or_before_ms, limit], map_pending_row)?;
        let items: rusqlite::Result<Vec<InboundPendingItem>> = rows.collect();
        Ok(items?)
    })
}

/// TODO(clawdentity): document `pending_count`.
pub fn pending_count(store: &SqliteStore) -> Result<i64> {
    store.with_connection(|connection| {
        let count =
            connection.query_row("SELECT COUNT(*) FROM inbound_pending", [], |row| row.get(0))?;
        Ok(count)
    })
}

/// TODO(clawdentity): document `get_pending`.
pub fn get_pending(store: &SqliteStore, request_id: &str) -> Result<Option<InboundPendingItem>> {
    let request_id = request_id.trim();
    if request_id.is_empty() {
        return Ok(None);
    }
    store.with_connection(|connection| {
        let mut statement = connection.prepare(
            "SELECT request_id, frame_id, from_agent_did, to_agent_did, payload_json, payload_bytes,
                    received_at_ms, next_attempt_at_ms, attempt_count, last_error, last_attempt_at_ms,
                    conversation_id, reply_to
             FROM inbound_pending
             WHERE request_id = ?1",
        )?;
        let item = statement.query_row([request_id], map_pending_row).optional()?;
        Ok(item)
    })
}

/// TODO(clawdentity): document `delete_pending`.
pub fn delete_pending(store: &SqliteStore, request_id: &str) -> Result<bool> {
    let request_id = request_id.trim();
    if request_id.is_empty() {
        return Ok(false);
    }
    store.with_connection(|connection| {
        let affected = connection.execute(
            "DELETE FROM inbound_pending WHERE request_id = ?1",
            [request_id],
        )?;
        Ok(affected > 0)
    })
}

/// TODO(clawdentity): document `mark_pending_attempt`.
pub fn mark_pending_attempt(
    store: &SqliteStore,
    request_id: &str,
    next_attempt_at_ms: i64,
    last_error: Option<String>,
) -> Result<bool> {
    let request_id = request_id.trim();
    if request_id.is_empty() {
        return Ok(false);
    }
    let last_error = parse_optional_non_empty(last_error);
    let last_attempt_at_ms = now_utc_ms();
    store.with_connection(|connection| {
        let affected = connection.execute(
            "UPDATE inbound_pending
             SET attempt_count = attempt_count + 1,
                 next_attempt_at_ms = ?2,
                 last_error = ?3,
                 last_attempt_at_ms = ?4
             WHERE request_id = ?1",
            params![
                request_id,
                next_attempt_at_ms,
                last_error,
                last_attempt_at_ms
            ],
        )?;
        Ok(affected > 0)
    })
}

/// TODO(clawdentity): document `move_pending_to_dead_letter`.
#[allow(clippy::too_many_lines)]
pub fn move_pending_to_dead_letter(
    store: &SqliteStore,
    request_id: &str,
    dead_letter_reason: &str,
) -> Result<bool> {
    let request_id = request_id.trim();
    let dead_letter_reason = dead_letter_reason.trim();
    if request_id.is_empty() {
        return Ok(false);
    }
    if dead_letter_reason.is_empty() {
        return Err(CoreError::InvalidInput(
            "dead_letter_reason is required".to_string(),
        ));
    }

    store.with_connection(|connection| {
        let mut select_statement = connection.prepare(
            "SELECT request_id, frame_id, from_agent_did, to_agent_did, payload_json, payload_bytes,
                    received_at_ms, next_attempt_at_ms, attempt_count, last_error, last_attempt_at_ms,
                    conversation_id, reply_to
             FROM inbound_pending
             WHERE request_id = ?1",
        )?;
        let pending = select_statement
            .query_row([request_id], map_pending_row)
            .optional()?;
        let Some(pending) = pending else {
            return Ok(false);
        };

        let dead_lettered_at_ms = now_utc_ms();
        connection.execute(
            "INSERT INTO inbound_dead_letter (
                request_id, frame_id, from_agent_did, to_agent_did, payload_json, payload_bytes,
                received_at_ms, attempt_count, last_error, last_attempt_at_ms, conversation_id, reply_to,
                dead_lettered_at_ms, dead_letter_reason
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
            ON CONFLICT(request_id) DO UPDATE SET
                frame_id = excluded.frame_id,
                from_agent_did = excluded.from_agent_did,
                to_agent_did = excluded.to_agent_did,
                payload_json = excluded.payload_json,
                payload_bytes = excluded.payload_bytes,
                received_at_ms = excluded.received_at_ms,
                attempt_count = excluded.attempt_count,
                last_error = excluded.last_error,
                last_attempt_at_ms = excluded.last_attempt_at_ms,
                conversation_id = excluded.conversation_id,
                reply_to = excluded.reply_to,
                dead_lettered_at_ms = excluded.dead_lettered_at_ms,
                dead_letter_reason = excluded.dead_letter_reason",
            params![
                pending.request_id,
                pending.frame_id,
                pending.from_agent_did,
                pending.to_agent_did,
                pending.payload_json,
                pending.payload_bytes,
                pending.received_at_ms,
                pending.attempt_count,
                pending.last_error,
                pending.last_attempt_at_ms,
                pending.conversation_id,
                pending.reply_to,
                dead_lettered_at_ms,
                dead_letter_reason
            ],
        )?;

        connection.execute(
            "DELETE FROM inbound_pending WHERE request_id = ?1",
            [request_id],
        )?;

        append_inbound_event_with_connection(
            connection,
            "dead_lettered",
            Some(request_id.to_string()),
            Some(
                serde_json::json!({
                    "reason": dead_letter_reason,
                    "deadLetteredAtMs": dead_lettered_at_ms,
                })
                .to_string(),
            ),
        )?;
        Ok(true)
    })
}

/// TODO(clawdentity): document `list_dead_letter`.
pub fn list_dead_letter(store: &SqliteStore, limit: usize) -> Result<Vec<InboundDeadLetterItem>> {
    let limit = i64::try_from(limit).unwrap_or(i64::MAX);
    store.with_connection(|connection| {
        let mut statement = connection.prepare(
            "SELECT request_id, frame_id, from_agent_did, to_agent_did, payload_json, payload_bytes,
                    received_at_ms, attempt_count, last_error, last_attempt_at_ms, conversation_id, reply_to,
                    dead_lettered_at_ms, dead_letter_reason
             FROM inbound_dead_letter
             ORDER BY dead_lettered_at_ms DESC, request_id DESC
             LIMIT ?1",
        )?;
        let rows = statement.query_map([limit], map_dead_letter_row)?;
        let items: rusqlite::Result<Vec<InboundDeadLetterItem>> = rows.collect();
        Ok(items?)
    })
}

/// TODO(clawdentity): document `dead_letter_count`.
pub fn dead_letter_count(store: &SqliteStore) -> Result<i64> {
    store.with_connection(|connection| {
        let count =
            connection.query_row("SELECT COUNT(*) FROM inbound_dead_letter", [], |row| {
                row.get(0)
            })?;
        Ok(count)
    })
}

/// TODO(clawdentity): document `replay_dead_letter`.
#[allow(clippy::too_many_lines)]
pub fn replay_dead_letter(
    store: &SqliteStore,
    request_id: &str,
    next_attempt_at_ms: i64,
) -> Result<bool> {
    let request_id = request_id.trim();
    if request_id.is_empty() {
        return Ok(false);
    }
    store.with_connection(|connection| {
        let mut statement = connection.prepare(
            "SELECT request_id, frame_id, from_agent_did, to_agent_did, payload_json, payload_bytes,
                    received_at_ms, attempt_count, last_error, last_attempt_at_ms, conversation_id, reply_to,
                    dead_lettered_at_ms, dead_letter_reason
             FROM inbound_dead_letter
             WHERE request_id = ?1",
        )?;
        let dead_letter = statement
            .query_row([request_id], map_dead_letter_row)
            .optional()?;
        let Some(dead_letter) = dead_letter else {
            return Ok(false);
        };

        connection.execute(
            "INSERT INTO inbound_pending (
                request_id, frame_id, from_agent_did, to_agent_did, payload_json, payload_bytes,
                received_at_ms, next_attempt_at_ms, attempt_count, last_error, last_attempt_at_ms,
                conversation_id, reply_to
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
            ON CONFLICT(request_id) DO UPDATE SET
                frame_id = excluded.frame_id,
                from_agent_did = excluded.from_agent_did,
                to_agent_did = excluded.to_agent_did,
                payload_json = excluded.payload_json,
                payload_bytes = excluded.payload_bytes,
                received_at_ms = excluded.received_at_ms,
                next_attempt_at_ms = excluded.next_attempt_at_ms,
                attempt_count = excluded.attempt_count,
                last_error = excluded.last_error,
                last_attempt_at_ms = excluded.last_attempt_at_ms,
                conversation_id = excluded.conversation_id,
                reply_to = excluded.reply_to",
            params![
                dead_letter.request_id,
                dead_letter.frame_id,
                dead_letter.from_agent_did,
                dead_letter.to_agent_did,
                dead_letter.payload_json,
                dead_letter.payload_bytes,
                dead_letter.received_at_ms,
                next_attempt_at_ms,
                dead_letter.attempt_count,
                dead_letter.last_error,
                dead_letter.last_attempt_at_ms,
                dead_letter.conversation_id,
                dead_letter.reply_to,
            ],
        )?;
        connection.execute(
            "DELETE FROM inbound_dead_letter WHERE request_id = ?1",
            [request_id],
        )?;
        append_inbound_event_with_connection(
            connection,
            "dead_letter_replayed",
            Some(request_id.to_string()),
            None,
        )?;
        Ok(true)
    })
}

/// TODO(clawdentity): document `purge_dead_letter`.
pub fn purge_dead_letter(store: &SqliteStore, request_id: Option<&str>) -> Result<usize> {
    store.with_connection(|connection| {
        let deleted = if let Some(request_id) = request_id {
            let request_id = request_id.trim();
            if request_id.is_empty() {
                0
            } else {
                connection.execute(
                    "DELETE FROM inbound_dead_letter WHERE request_id = ?1",
                    [request_id],
                )?
            }
        } else {
            connection.execute("DELETE FROM inbound_dead_letter", [])?
        };
        Ok(deleted)
    })
}

/// TODO(clawdentity): document `append_inbound_event`.
pub fn append_inbound_event(
    store: &SqliteStore,
    event_type: &str,
    request_id: Option<String>,
    details_json: Option<String>,
) -> Result<i64> {
    let event_type = event_type.trim().to_string();
    if event_type.is_empty() {
        return Err(CoreError::InvalidInput(
            "event_type is required".to_string(),
        ));
    }
    store.with_connection(|connection| {
        append_inbound_event_with_connection(
            connection,
            &event_type,
            request_id,
            parse_optional_non_empty(details_json),
        )
    })
}

fn append_inbound_event_with_connection(
    connection: &rusqlite::Connection,
    event_type: &str,
    request_id: Option<String>,
    details_json: Option<String>,
) -> Result<i64> {
    let now_ms = now_utc_ms();
    connection.execute(
        "INSERT INTO inbound_events (at_ms, event_type, request_id, details_json)
         VALUES (?1, ?2, ?3, ?4)",
        params![
            now_ms,
            event_type,
            parse_optional_non_empty(request_id),
            parse_optional_non_empty(details_json),
        ],
    )?;
    Ok(connection.last_insert_rowid())
}

/// TODO(clawdentity): document `list_inbound_events`.
pub fn list_inbound_events(store: &SqliteStore, limit: usize) -> Result<Vec<InboundEvent>> {
    let limit = i64::try_from(limit).unwrap_or(i64::MAX);
    store.with_connection(|connection| {
        let mut statement = connection.prepare(
            "SELECT id, at_ms, event_type, request_id, details_json
             FROM inbound_events
             ORDER BY id DESC
             LIMIT ?1",
        )?;
        let rows = statement.query_map([limit], |row| {
            Ok(InboundEvent {
                id: row.get(0)?,
                at_ms: row.get(1)?,
                event_type: row.get(2)?,
                request_id: row.get(3)?,
                details_json: row.get(4)?,
            })
        })?;
        let items: rusqlite::Result<Vec<InboundEvent>> = rows.collect();
        Ok(items?)
    })
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use crate::db::SqliteStore;

    use super::{
        InboundPendingItem, append_inbound_event, delete_pending, get_pending, list_dead_letter,
        list_inbound_events, list_pending_due, mark_pending_attempt, move_pending_to_dead_letter,
        purge_dead_letter, replay_dead_letter, upsert_pending,
    };

    fn fixture_pending(request_id: &str) -> InboundPendingItem {
        InboundPendingItem {
            request_id: request_id.to_string(),
            frame_id: "frame-1".to_string(),
            from_agent_did: "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXTD"
                .to_string(),
            to_agent_did: "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXTE"
                .to_string(),
            payload_json: "{\"message\":\"hello\"}".to_string(),
            payload_bytes: 20,
            received_at_ms: 100,
            next_attempt_at_ms: 100,
            attempt_count: 0,
            last_error: None,
            last_attempt_at_ms: None,
            conversation_id: Some("conv-1".to_string()),
            reply_to: None,
        }
    }

    #[test]
    fn pending_dead_letter_and_replay_round_trip() {
        let temp = TempDir::new().expect("temp dir");
        let store = SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("open db");

        upsert_pending(&store, fixture_pending("req-1")).expect("upsert");
        let due = list_pending_due(&store, 100, 10).expect("due");
        assert_eq!(due.len(), 1);

        let marked = mark_pending_attempt(&store, "req-1", 200, Some("retry failed".to_string()))
            .expect("mark");
        assert!(marked);
        let pending = get_pending(&store, "req-1")
            .expect("get pending")
            .expect("pending");
        assert_eq!(pending.attempt_count, 1);
        assert_eq!(pending.last_error.as_deref(), Some("retry failed"));

        let moved = move_pending_to_dead_letter(&store, "req-1", "max-attempts-exceeded")
            .expect("move dead letter");
        assert!(moved);
        assert!(
            get_pending(&store, "req-1")
                .expect("get pending none")
                .is_none()
        );
        assert_eq!(list_dead_letter(&store, 10).expect("dead letters").len(), 1);

        let replayed = replay_dead_letter(&store, "req-1", 300).expect("replay");
        assert!(replayed);
        assert_eq!(
            list_dead_letter(&store, 10)
                .expect("dead letters after")
                .len(),
            0
        );
        assert!(
            get_pending(&store, "req-1")
                .expect("get pending after")
                .is_some()
        );

        let purged_none = purge_dead_letter(&store, None).expect("purge none");
        assert_eq!(purged_none, 0);
    }

    #[test]
    fn delete_pending_removes_existing_row() {
        let temp = TempDir::new().expect("temp dir");
        let store = SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("open db");

        upsert_pending(&store, fixture_pending("req-delete")).expect("upsert");
        let deleted = delete_pending(&store, "req-delete").expect("delete pending");
        assert!(deleted);
        assert!(
            get_pending(&store, "req-delete")
                .expect("get pending")
                .is_none()
        );
    }

    #[test]
    fn append_and_list_events() {
        let temp = TempDir::new().expect("temp dir");
        let store = SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("open db");

        let inserted_id = append_inbound_event(
            &store,
            "received",
            Some("req-123".to_string()),
            Some("{\"ok\":true}".to_string()),
        )
        .expect("append event");
        assert!(inserted_id > 0);

        let events = list_inbound_events(&store, 10).expect("list events");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "received");
        assert_eq!(events[0].request_id.as_deref(), Some("req-123"));
    }
}
