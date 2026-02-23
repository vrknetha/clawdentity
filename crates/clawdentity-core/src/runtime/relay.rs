use crate::connector_client::ConnectorClientSender;
use crate::connector_frames::{CONNECTOR_FRAME_VERSION, ConnectorFrame, EnqueueFrame, now_iso};
use crate::db::SqliteStore;
use crate::db_outbound::{
    EnqueueOutboundInput, OutboundQueueItem, enqueue_outbound, move_outbound_to_dead_letter,
    take_oldest_outbound,
};
use crate::error::Result;
use crate::runtime_trusted_receipts::TrustedReceiptsStore;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlushOutboundResult {
    pub sent_count: usize,
    pub failed_count: usize,
}

pub async fn flush_outbound_queue_to_relay(
    store: &SqliteStore,
    relay: &ConnectorClientSender,
    max_items: usize,
    trusted_receipts: Option<&TrustedReceiptsStore>,
) -> Result<FlushOutboundResult> {
    let mut sent_count = 0_usize;
    let mut failed_count = 0_usize;

    for _ in 0..max_items {
        if !relay.is_connected() {
            break;
        }

        let Some(item) = take_oldest_outbound(store)? else {
            break;
        };

        let payload = match serde_json::from_str::<serde_json::Value>(&item.payload_json) {
            Ok(payload) => payload,
            Err(error) => {
                tracing::warn!(
                    frame_id = %item.frame_id,
                    to_agent_did = %item.to_agent_did,
                    error = %error,
                    "malformed outbound payload moved to dead letter"
                );
                if let Err(dead_letter_error) =
                    dead_letter_malformed_outbound_payload(store, &item, &error)
                {
                    tracing::warn!(
                        frame_id = %item.frame_id,
                        to_agent_did = %item.to_agent_did,
                        error = %dead_letter_error,
                        "failed to move malformed outbound payload to dead letter"
                    );
                }
                failed_count += 1;
                continue;
            }
        };

        let frame = ConnectorFrame::Enqueue(EnqueueFrame {
            v: CONNECTOR_FRAME_VERSION,
            id: item.frame_id.clone(),
            ts: now_iso(),
            to_agent_did: item.to_agent_did.clone(),
            payload,
            conversation_id: item.conversation_id.clone(),
            reply_to: item.reply_to.clone(),
        });

        if relay.send_frame(frame).await.is_err() {
            // Requeue on best effort if the relay connection failed.
            enqueue_outbound(
                store,
                EnqueueOutboundInput {
                    frame_id: item.frame_id,
                    frame_version: item.frame_version,
                    frame_type: item.frame_type,
                    to_agent_did: item.to_agent_did,
                    payload_json: item.payload_json,
                    conversation_id: item.conversation_id,
                    reply_to: item.reply_to,
                },
            )?;
            failed_count += 1;
            break;
        }

        if let Some(receipts) = trusted_receipts {
            receipts.mark_trusted(item.frame_id);
        }
        sent_count += 1;
    }

    Ok(FlushOutboundResult {
        sent_count,
        failed_count,
    })
}

fn dead_letter_malformed_outbound_payload(
    store: &SqliteStore,
    item: &OutboundQueueItem,
    parse_error: &serde_json::Error,
) -> Result<()> {
    move_outbound_to_dead_letter(
        store,
        item,
        &format!("malformed outbound payload: {parse_error}"),
    )
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tempfile::TempDir;

    use crate::connector_client::{ConnectorClientOptions, spawn_connector_client};
    use crate::db::SqliteStore;
    use crate::db_outbound::{
        EnqueueOutboundInput, enqueue_outbound, list_outbound_dead_letter, outbound_count,
        take_oldest_outbound,
    };
    use crate::runtime_trusted_receipts::TrustedReceiptsStore;

    use super::{dead_letter_malformed_outbound_payload, flush_outbound_queue_to_relay};

    #[tokio::test]
    async fn flush_keeps_message_when_relay_is_disconnected() {
        let temp = TempDir::new().expect("temp dir");
        let store = SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("open db");
        enqueue_outbound(
            &store,
            EnqueueOutboundInput {
                frame_id: "frame-1".to_string(),
                frame_version: 1,
                frame_type: "enqueue".to_string(),
                to_agent_did: "did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4".to_string(),
                payload_json: "{\"x\":1}".to_string(),
                conversation_id: None,
                reply_to: None,
            },
        )
        .expect("enqueue");

        let client = spawn_connector_client(ConnectorClientOptions::with_defaults(
            "ws://127.0.0.1:9/v1/relay/connect",
            vec![],
        ));
        tokio::time::sleep(Duration::from_millis(25)).await;

        let receipts = TrustedReceiptsStore::new();
        let result = flush_outbound_queue_to_relay(&store, &client.sender(), 10, Some(&receipts))
            .await
            .expect("flush");
        assert_eq!(result.sent_count, 0);
        assert_eq!(result.failed_count, 0);
        assert_eq!(outbound_count(&store).expect("count"), 1);
        client.sender().shutdown();
    }

    #[test]
    fn malformed_outbound_payload_moves_to_dead_letter_with_context() {
        let temp = TempDir::new().expect("temp dir");
        let store = SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("open db");
        enqueue_outbound(
            &store,
            EnqueueOutboundInput {
                frame_id: "frame-1".to_string(),
                frame_version: 1,
                frame_type: "enqueue".to_string(),
                to_agent_did: "did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4".to_string(),
                payload_json: "{\"unterminated\"".to_string(),
                conversation_id: None,
                reply_to: None,
            },
        )
        .expect("enqueue");
        let item = take_oldest_outbound(&store).expect("take").expect("item");
        let parse_error =
            serde_json::from_str::<serde_json::Value>(&item.payload_json).expect_err("invalid");
        dead_letter_malformed_outbound_payload(&store, &item, &parse_error).expect("dead letter");

        let dead_letter = list_outbound_dead_letter(&store, 10).expect("dead letters");
        assert_eq!(dead_letter.len(), 1);
        assert_eq!(dead_letter[0].frame_id, "frame-1");
        assert!(
            dead_letter[0]
                .dead_letter_reason
                .contains("malformed outbound payload")
        );
    }
}
