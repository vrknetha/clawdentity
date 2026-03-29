use crate::connector_client::ConnectorClientSender;
use crate::connector_frames::{CONNECTOR_FRAME_VERSION, ConnectorFrame, EnqueueFrame, now_iso};
use crate::db::{SqliteStore, now_utc_ms};
use crate::db_outbound::{
    OutboundQueueItem, move_outbound_to_dead_letter, requeue_outbound_retry, take_due_outbound,
};
use crate::error::Result;
use crate::runtime_trusted_receipts::TrustedReceiptsStore;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SentOutboundFrame {
    pub frame_id: String,
    pub to_agent_did: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutboundSendObservation {
    Queued,
    Sent,
    SendFailed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlushOutboundResult {
    pub sent_frames: Vec<SentOutboundFrame>,
    pub sent_count: usize,
    pub failed_count: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OutboundRetryPolicy {
    pub initial_delay_ms: i64,
    pub max_delay_ms: i64,
    pub backoff_factor: f64,
    pub max_attempts: i64,
    pub max_age_ms: i64,
}

impl Default for OutboundRetryPolicy {
    fn default() -> Self {
        Self {
            initial_delay_ms: 1_000,
            max_delay_ms: 60_000,
            backoff_factor: 2.0,
            max_attempts: 30,
            max_age_ms: 24 * 60 * 60 * 1_000,
        }
    }
}

impl OutboundRetryPolicy {
    /// Loads outbound retry policy from connector runtime environment variables,
    /// falling back to `Default` values when variables are missing or invalid.
    pub fn from_env() -> Self {
        let default = Self::default();
        Self {
            initial_delay_ms: parse_env_i64(
                "CONNECTOR_OUTBOUND_RETRY_INITIAL_DELAY_MS",
                default.initial_delay_ms,
            ),
            max_delay_ms: parse_env_i64(
                "CONNECTOR_OUTBOUND_RETRY_MAX_DELAY_MS",
                default.max_delay_ms,
            ),
            backoff_factor: parse_env_f64(
                "CONNECTOR_OUTBOUND_RETRY_BACKOFF_FACTOR",
                default.backoff_factor,
            ),
            max_attempts: parse_env_i64(
                "CONNECTOR_OUTBOUND_RETRY_MAX_ATTEMPTS",
                default.max_attempts,
            ),
            max_age_ms: parse_env_i64("CONNECTOR_OUTBOUND_MAX_AGE_MS", default.max_age_ms),
        }
    }
}

fn parse_env_i64(name: &str, default: i64) -> i64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

fn parse_env_f64(name: &str, default: f64) -> f64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| *value >= 1.0)
        .unwrap_or(default)
}

fn compute_retry_delay_ms(attempt_count: i64, policy: &OutboundRetryPolicy) -> i64 {
    let exponent = (attempt_count.saturating_sub(1)) as i32;
    let backoff = (policy.initial_delay_ms as f64) * policy.backoff_factor.powi(exponent);
    (backoff.floor() as i64).clamp(1, policy.max_delay_ms)
}

/// TODO(clawdentity): document `flush_outbound_queue_to_relay_with_sent_observer`.
#[allow(clippy::too_many_lines)]
pub async fn flush_outbound_queue_to_relay_with_send_observer<F>(
    store: &SqliteStore,
    relay: &ConnectorClientSender,
    max_items: usize,
    trusted_receipts: Option<&TrustedReceiptsStore>,
    mut observe_send: F,
) -> Result<FlushOutboundResult>
where
    F: FnMut(&SentOutboundFrame, OutboundSendObservation),
{
    let policy = OutboundRetryPolicy::from_env();
    let mut sent_frames: Vec<SentOutboundFrame> = Vec::new();
    let mut sent_count = 0_usize;
    let mut failed_count = 0_usize;

    for _ in 0..max_items {
        if !relay.is_connected() {
            break;
        }

        let now_ms = now_utc_ms();
        let Some(item) = take_due_outbound(store, now_ms)? else {
            break;
        };

        let age_ms = now_ms.saturating_sub(item.created_at_ms);
        if age_ms > policy.max_age_ms {
            move_outbound_to_dead_letter(
                store,
                &item,
                "outbound message expired before relay delivery",
            )?;
            failed_count += 1;
            continue;
        }

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

        let sent_frame = SentOutboundFrame {
            frame_id: item.frame_id.clone(),
            to_agent_did: item.to_agent_did.clone(),
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

        observe_send(&sent_frame, OutboundSendObservation::Queued);
        if relay.send_frame(frame).await.is_err() {
            observe_send(&sent_frame, OutboundSendObservation::SendFailed);
            if item.attempt_count + 1 >= policy.max_attempts {
                move_outbound_to_dead_letter(
                    store,
                    &item,
                    "outbound relay delivery failed after max retry attempts",
                )?;
                failed_count += 1;
                continue;
            }

            let retry_delay_ms = compute_retry_delay_ms(item.attempt_count + 1, &policy);
            requeue_outbound_retry(
                store,
                &item,
                now_ms + retry_delay_ms,
                "relay websocket send failed",
            )?;
            failed_count += 1;
            break;
        }

        observe_send(&sent_frame, OutboundSendObservation::Sent);
        if let Some(receipts) = trusted_receipts {
            receipts.mark_trusted(item.frame_id.clone());
        }
        sent_frames.push(sent_frame);
        sent_count += 1;
    }

    Ok(FlushOutboundResult {
        sent_frames,
        sent_count,
        failed_count,
    })
}

/// TODO(clawdentity): document `flush_outbound_queue_to_relay_with_sent_observer`.
pub async fn flush_outbound_queue_to_relay_with_sent_observer<F>(
    store: &SqliteStore,
    relay: &ConnectorClientSender,
    max_items: usize,
    trusted_receipts: Option<&TrustedReceiptsStore>,
    mut observe_sent: F,
) -> Result<FlushOutboundResult>
where
    F: FnMut(&SentOutboundFrame),
{
    flush_outbound_queue_to_relay_with_send_observer(
        store,
        relay,
        max_items,
        trusted_receipts,
        |sent, observation| {
            if observation == OutboundSendObservation::Sent {
                observe_sent(sent);
            }
        },
    )
    .await
}

/// TODO(clawdentity): document `flush_outbound_queue_to_relay`.
pub async fn flush_outbound_queue_to_relay(
    store: &SqliteStore,
    relay: &ConnectorClientSender,
    max_items: usize,
    trusted_receipts: Option<&TrustedReceiptsStore>,
) -> Result<FlushOutboundResult> {
    flush_outbound_queue_to_relay_with_sent_observer(
        store,
        relay,
        max_items,
        trusted_receipts,
        |_| {},
    )
    .await
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
        take_due_outbound,
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
                to_agent_did: "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4"
                    .to_string(),
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
                to_agent_did: "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4"
                    .to_string(),
                payload_json: "{\"unterminated\"".to_string(),
                conversation_id: None,
                reply_to: None,
            },
        )
        .expect("enqueue");
        let item = take_due_outbound(&store, i64::MAX)
            .expect("take")
            .expect("item");
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
