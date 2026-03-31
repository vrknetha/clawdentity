use crate::db::SqliteStore;
use crate::db::now_utc_ms;
use crate::db_inbound::{list_dead_letter, purge_dead_letter, replay_dead_letter};
use crate::error::Result;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplayResult {
    pub replayed_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PurgeResult {
    pub purged_count: usize,
}

/// TODO(clawdentity): document `replay_dead_letter_messages`.
pub fn replay_dead_letter_messages(
    store: &SqliteStore,
    request_ids: Option<Vec<String>>,
) -> Result<ReplayResult> {
    let mut replayed_count = 0_usize;
    let next_attempt_at_ms = now_utc_ms();

    match request_ids {
        Some(ids) if !ids.is_empty() => {
            for request_id in ids {
                if replay_dead_letter(store, &request_id, next_attempt_at_ms)? {
                    replayed_count += 1;
                }
            }
        }
        _ => {
            for item in list_dead_letter(store, usize::MAX)? {
                if replay_dead_letter(store, &item.request_id, next_attempt_at_ms)? {
                    replayed_count += 1;
                }
            }
        }
    }

    Ok(ReplayResult { replayed_count })
}

/// TODO(clawdentity): document `purge_dead_letter_messages`.
pub fn purge_dead_letter_messages(
    store: &SqliteStore,
    request_ids: Option<Vec<String>>,
) -> Result<PurgeResult> {
    let purged_count = match request_ids {
        Some(ids) if !ids.is_empty() => {
            let mut total = 0_usize;
            for request_id in ids {
                total += purge_dead_letter(store, Some(&request_id))?;
            }
            total
        }
        _ => purge_dead_letter(store, None)?,
    };

    Ok(PurgeResult { purged_count })
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use crate::db::SqliteStore;
    use crate::db_inbound::{InboundPendingItem, move_pending_to_dead_letter, upsert_pending};

    use super::{purge_dead_letter_messages, replay_dead_letter_messages};

    fn fixture_pending(request_id: &str) -> InboundPendingItem {
        InboundPendingItem {
            request_id: request_id.to_string(),
            frame_id: "frame-1".to_string(),
            from_agent_did: "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXTD"
                .to_string(),
            to_agent_did: "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXTE"
                .to_string(),
            group_id: None,
            payload_json: "{}".to_string(),
            payload_bytes: 2,
            received_at_ms: 1,
            next_attempt_at_ms: 1,
            attempt_count: 0,
            last_error: None,
            last_attempt_at_ms: None,
            delivery_source: None,
            conversation_id: None,
            reply_to: None,
        }
    }

    #[test]
    fn replay_and_purge_helpers_operate_on_dead_letter_items() {
        let temp = TempDir::new().expect("temp dir");
        let store = SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("open db");

        upsert_pending(&store, fixture_pending("req-1")).expect("upsert");
        move_pending_to_dead_letter(&store, "req-1", "test").expect("dead letter");

        let replayed = replay_dead_letter_messages(&store, None).expect("replay");
        assert_eq!(replayed.replayed_count, 1);

        move_pending_to_dead_letter(&store, "req-1", "test-2").expect("dead letter again");
        let purged = purge_dead_letter_messages(&store, None).expect("purge");
        assert_eq!(purged.purged_count, 1);
    }
}
