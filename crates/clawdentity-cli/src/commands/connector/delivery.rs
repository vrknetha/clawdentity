use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Result, anyhow};
use clawdentity_core::db::now_utc_ms;
use clawdentity_core::db_inbound::{
    InboundPendingItem, append_inbound_event, delete_pending, list_pending_due,
    mark_pending_attempt, move_pending_to_dead_letter, upsert_pending,
};
use clawdentity_core::http::client as create_http_client;
use clawdentity_core::runtime_openclaw::OpenclawRuntimeConfig;
use clawdentity_core::{
    CONNECTOR_FRAME_VERSION, ConnectorClient, ConnectorClientSender, ConnectorFrame,
    DeliverAckFrame, DeliverFrame, EnqueueAckFrame, ReceiptFrame, SqliteStore, new_frame_id,
    now_iso,
};
use serde_json::{Value, json};
use tokio::sync::watch;

use super::headers::{
    SenderProfileHeaders, build_openclaw_delivery_headers, lookup_sender_profile_headers,
};
use super::receipts::{DeliveryReceiptPayload, DeliveryReceiptStatus, ReceiptOutboxHandle};
pub(super) use openclaw_payload::{build_openclaw_hook_payload, build_openclaw_receipt_payload};
use pair_accepted::apply_pair_accepted_system_delivery;

mod openclaw_payload;
mod pair_accepted;

const CONNECTOR_RETRY_DELAY_MS: i64 = 5_000;
const INBOUND_RETRY_INTERVAL: Duration = Duration::from_secs(1);
const INBOUND_RETRY_BATCH_SIZE: usize = 50;
const INBOUND_MAX_ATTEMPTS: i64 = 3;

pub(super) async fn run_inbound_loop(
    receipt_outbox: ReceiptOutboxHandle,
    mut connector_client: ConnectorClient,
    relay_sender: ConnectorClientSender,
    store: SqliteStore,
    config_dir: PathBuf,
    openclaw_runtime: OpenclawRuntimeConfig,
    mut shutdown_rx: watch::Receiver<bool>,
) -> Result<()> {
    let hook_url = openclaw_runtime.hook_url()?;
    let http_client = create_http_client()?;

    loop {
        tokio::select! {
            _ = shutdown_rx.changed() => {
                if *shutdown_rx.borrow() {
                    return Ok(());
                }
            }
            frame = connector_client.recv_frame() => {
                let Some(frame) = frame else {
                    return Ok(());
                };
                handle_connector_frame(
                    frame,
                    &store,
                    config_dir.as_path(),
                    &relay_sender,
                    &http_client,
                    &hook_url,
                    &openclaw_runtime,
                    &receipt_outbox,
                )
                .await;
            }
        }
    }
}

async fn handle_connector_frame(
    frame: ConnectorFrame,
    store: &SqliteStore,
    config_dir: &Path,
    relay_sender: &ConnectorClientSender,
    http_client: &reqwest::Client,
    hook_url: &str,
    openclaw_runtime: &OpenclawRuntimeConfig,
    receipt_outbox: &ReceiptOutboxHandle,
) {
    match frame {
        ConnectorFrame::Deliver(deliver) => {
            handle_deliver_frame(
                store,
                config_dir,
                relay_sender,
                http_client,
                hook_url,
                openclaw_runtime,
                receipt_outbox,
                deliver,
            )
            .await;
        }
        ConnectorFrame::Receipt(receipt) => {
            if let Err(error) =
                forward_receipt_to_openclaw(http_client, hook_url, openclaw_runtime, &receipt).await
            {
                tracing::warn!(
                    error = %error,
                    request_id = %receipt.original_frame_id,
                    status = ?receipt.status,
                    "failed to forward receipt payload to OpenClaw hook"
                );
            }
        }
        ConnectorFrame::EnqueueAck(ack) => log_enqueue_ack(&ack),
        _ => {}
    }
}

fn log_enqueue_ack(ack: &EnqueueAckFrame) {
    if ack.accepted {
        tracing::debug!(ack_id = %ack.ack_id, "relay accepted outbound enqueue frame");
        return;
    }

    let reason = ack.reason.as_deref().unwrap_or("unknown");
    tracing::warn!(
        ack_id = %ack.ack_id,
        reason,
        "relay rejected outbound enqueue frame"
    );
}

pub(super) async fn run_inbound_retry_loop(
    receipt_outbox: ReceiptOutboxHandle,
    store: SqliteStore,
    config_dir: PathBuf,
    openclaw_runtime: OpenclawRuntimeConfig,
    mut shutdown_rx: watch::Receiver<bool>,
) -> Result<()> {
    let hook_url = openclaw_runtime.hook_url()?;
    let http_client = create_http_client()?;
    let mut interval = tokio::time::interval(INBOUND_RETRY_INTERVAL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            _ = shutdown_rx.changed() => {
                if *shutdown_rx.borrow() {
                    return Ok(());
                }
            }
            _ = interval.tick() => {
                let _ = receipt_outbox.flush_due().await;
                retry_due_inbound_deliveries(
                    &store,
                    config_dir.as_path(),
                    &http_client,
                    &hook_url,
                    &openclaw_runtime,
                    &receipt_outbox,
                )
                .await;
            }
        }
    }
}

async fn retry_due_inbound_deliveries(
    store: &SqliteStore,
    config_dir: &Path,
    http_client: &reqwest::Client,
    hook_url: &str,
    openclaw_runtime: &OpenclawRuntimeConfig,
    receipt_outbox: &ReceiptOutboxHandle,
) {
    let due_items = match list_pending_due(store, now_utc_ms(), INBOUND_RETRY_BATCH_SIZE) {
        Ok(items) => items,
        Err(error) => {
            tracing::warn!(error = %error, "failed to list pending inbound deliveries");
            return;
        }
    };

    for item in due_items {
        retry_pending_inbound_delivery(
            store,
            config_dir,
            http_client,
            hook_url,
            openclaw_runtime,
            receipt_outbox,
            item,
        )
        .await;
    }
}

async fn retry_pending_inbound_delivery(
    store: &SqliteStore,
    config_dir: &Path,
    http_client: &reqwest::Client,
    hook_url: &str,
    openclaw_runtime: &OpenclawRuntimeConfig,
    receipt_outbox: &ReceiptOutboxHandle,
    item: InboundPendingItem,
) {
    let Ok(mut deliver) = build_deliver_from_pending(&item) else {
        dead_letter_invalid_pending_payload(store, receipt_outbox, &item).await;
        return;
    };
    if let Err(error) = apply_pair_accepted_system_delivery(store, config_dir, &mut deliver) {
        handle_pending_retry_failure(store, receipt_outbox, &item, &error).await;
        return;
    }

    let sender_profile = lookup_sender_profile_headers(store, &item.from_agent_did);
    match forward_deliver_to_openclaw(
        http_client,
        hook_url,
        openclaw_runtime,
        &deliver,
        sender_profile.as_ref(),
    )
    .await
    {
        Ok(()) => {
            record_retry_delivery_success(store, &item);
            let _ = receipt_outbox
                .enqueue_and_try_flush(DeliveryReceiptPayload {
                    request_id: item.request_id.clone(),
                    sender_agent_did: item.from_agent_did.clone(),
                    recipient_agent_did: item.to_agent_did.clone(),
                    status: DeliveryReceiptStatus::ProcessedByOpenclaw,
                    reason: None,
                })
                .await;
        }
        Err(error) => handle_pending_retry_failure(store, receipt_outbox, &item, &error).await,
    }
}

fn build_deliver_from_pending(item: &InboundPendingItem) -> Result<DeliverFrame> {
    let payload = serde_json::from_str::<Value>(&item.payload_json)
        .map_err(|error| anyhow!("invalid pending payload_json: {error}"))?;

    Ok(DeliverFrame {
        v: CONNECTOR_FRAME_VERSION,
        id: item.request_id.clone(),
        ts: now_iso(),
        from_agent_did: item.from_agent_did.clone(),
        to_agent_did: item.to_agent_did.clone(),
        payload,
        delivery_source: item.delivery_source.clone(),
        content_type: Some("application/json".to_string()),
        conversation_id: item.conversation_id.clone(),
        reply_to: item.reply_to.clone(),
    })
}

async fn dead_letter_invalid_pending_payload(
    store: &SqliteStore,
    receipt_outbox: &ReceiptOutboxHandle,
    item: &InboundPendingItem,
) {
    let reason = build_deliver_from_pending(item)
        .err()
        .map(|error| error.to_string())
        .unwrap_or_else(|| "invalid pending payload_json".to_string());
    let moved_to_dead_letter = move_pending_to_dead_letter(store, &item.request_id, &reason);
    if let Err(error) = moved_to_dead_letter {
        tracing::warn!(
            error = %error,
            request_id = %item.request_id,
            "failed to move invalid pending payload to dead letter"
        );
        return;
    }
    let _ = receipt_outbox
        .enqueue_and_try_flush(DeliveryReceiptPayload {
            request_id: item.request_id.clone(),
            sender_agent_did: item.from_agent_did.clone(),
            recipient_agent_did: item.to_agent_did.clone(),
            status: DeliveryReceiptStatus::DeadLettered,
            reason: Some(reason),
        })
        .await;
}

fn record_retry_delivery_success(store: &SqliteStore, item: &InboundPendingItem) {
    if let Err(error) = delete_pending(store, &item.request_id) {
        tracing::warn!(
            error = %error,
            request_id = %item.request_id,
            "failed to clear resolved pending inbound delivery"
        );
        return;
    }

    if let Err(error) = append_inbound_event(
        store,
        "delivered_retry",
        Some(item.request_id.clone()),
        Some(json!({ "frameId": item.frame_id }).to_string()),
    ) {
        tracing::warn!(
            error = %error,
            request_id = %item.request_id,
            "failed to append delivered_retry inbound event"
        );
    }
}

pub(super) fn should_dead_letter_after_failure(current_attempt_count: i64) -> bool {
    current_attempt_count.saturating_add(1) >= INBOUND_MAX_ATTEMPTS
}

async fn handle_pending_retry_failure(
    store: &SqliteStore,
    receipt_outbox: &ReceiptOutboxHandle,
    item: &InboundPendingItem,
    error: &anyhow::Error,
) {
    if should_dead_letter_after_failure(item.attempt_count) {
        dead_letter_pending_retry(store, receipt_outbox, item, error).await;
        return;
    }

    schedule_pending_retry(store, item, error);
}

async fn dead_letter_pending_retry(
    store: &SqliteStore,
    receipt_outbox: &ReceiptOutboxHandle,
    item: &InboundPendingItem,
    error: &anyhow::Error,
) {
    let reason = format!("max retry attempts exceeded: {error}");
    let moved_to_dead_letter = move_pending_to_dead_letter(store, &item.request_id, &reason);
    if let Err(move_error) = moved_to_dead_letter {
        tracing::warn!(
            error = %move_error,
            request_id = %item.request_id,
            "failed to move pending inbound delivery to dead letter"
        );
        return;
    }
    let _ = receipt_outbox
        .enqueue_and_try_flush(DeliveryReceiptPayload {
            request_id: item.request_id.clone(),
            sender_agent_did: item.from_agent_did.clone(),
            recipient_agent_did: item.to_agent_did.clone(),
            status: DeliveryReceiptStatus::DeadLettered,
            reason: Some(reason),
        })
        .await;
}

fn schedule_pending_retry(store: &SqliteStore, item: &InboundPendingItem, error: &anyhow::Error) {
    let next_attempt_at_ms = now_utc_ms() + CONNECTOR_RETRY_DELAY_MS;
    if let Err(mark_error) = mark_pending_attempt(
        store,
        &item.request_id,
        next_attempt_at_ms,
        Some(error.to_string()),
    ) {
        tracing::warn!(
            error = %mark_error,
            request_id = %item.request_id,
            "failed to update pending inbound retry attempt"
        );
        return;
    }

    if let Err(event_error) = append_inbound_event(
        store,
        "pending_retry",
        Some(item.request_id.clone()),
        Some(
            json!({
                "frameId": item.frame_id,
                "attemptCount": item.attempt_count + 1,
                "nextAttemptAtMs": next_attempt_at_ms,
            })
            .to_string(),
        ),
    ) {
        tracing::warn!(
            error = %event_error,
            request_id = %item.request_id,
            "failed to append pending_retry inbound event"
        );
    }
}

async fn handle_deliver_frame(
    store: &SqliteStore,
    config_dir: &Path,
    relay_sender: &ConnectorClientSender,
    http_client: &reqwest::Client,
    hook_url: &str,
    openclaw_runtime: &OpenclawRuntimeConfig,
    receipt_outbox: &ReceiptOutboxHandle,
    mut deliver: DeliverFrame,
) {
    let system_delivery_result =
        apply_pair_accepted_system_delivery(store, config_dir, &mut deliver);
    let sender_profile = lookup_sender_profile_headers(store, &deliver.from_agent_did);
    let delivery_result = match system_delivery_result {
        Ok(_) => {
            forward_deliver_to_openclaw(
                http_client,
                hook_url,
                openclaw_runtime,
                &deliver,
                sender_profile.as_ref(),
            )
            .await
        }
        Err(error) => Err(error),
    };
    let delivery_succeeded = delivery_result.is_ok();
    let persistence_result =
        persist_inbound_delivery_result(store, &deliver, delivery_result.as_ref()).await;
    log_persist_failure(&deliver.id, persistence_result.as_ref().err());

    let ack_reason = build_deliver_ack_reason(
        delivery_result.as_ref().err(),
        persistence_result.as_ref().err(),
    );
    let ack_accepted = ack_reason.is_none();
    send_deliver_ack(relay_sender, &deliver.id, ack_accepted, ack_reason).await;
    log_delivery_failure(&deliver, delivery_result.err());

    if delivery_succeeded {
        let _ = receipt_outbox
            .enqueue_and_try_flush(DeliveryReceiptPayload {
                request_id: deliver.id.clone(),
                sender_agent_did: deliver.from_agent_did.clone(),
                recipient_agent_did: deliver.to_agent_did.clone(),
                status: DeliveryReceiptStatus::ProcessedByOpenclaw,
                reason: None,
            })
            .await;
    }
}

fn log_persist_failure(request_id: &str, persistence_error: Option<&anyhow::Error>) {
    if let Some(error) = persistence_error {
        tracing::warn!(error = %error, request_id, "failed to persist inbound delivery result");
    }
}

fn log_delivery_failure(deliver: &DeliverFrame, delivery_error: Option<anyhow::Error>) {
    if let Some(error) = delivery_error {
        tracing::warn!(
            error = %error,
            request_id = %deliver.id,
            to_agent_did = %deliver.to_agent_did,
            "failed to forward inbound payload to OpenClaw hook"
        );
    }
}

pub(super) fn build_deliver_ack_reason(
    delivery_error: Option<&anyhow::Error>,
    persistence_error: Option<&anyhow::Error>,
) -> Option<String> {
    match (delivery_error, persistence_error) {
        (Some(delivery_error), Some(persistence_error)) => Some(format!(
            "{delivery_error}; failed to persist inbound delivery result: {persistence_error}"
        )),
        _ => None,
    }
}

pub(super) async fn forward_deliver_to_openclaw(
    http_client: &reqwest::Client,
    hook_url: &str,
    openclaw_runtime: &OpenclawRuntimeConfig,
    deliver: &DeliverFrame,
    sender_profile: Option<&SenderProfileHeaders>,
) -> Result<()> {
    let mut request = http_client
        .post(hook_url)
        .json(&build_openclaw_hook_payload(
            &openclaw_runtime.hook_path,
            deliver,
            openclaw_runtime.target_agent_id.as_deref(),
        ));

    for (name, value) in build_openclaw_delivery_headers(
        deliver,
        sender_profile,
        openclaw_runtime.hook_token.as_deref(),
    ) {
        request = request.header(name, value);
    }

    let response = request
        .send()
        .await
        .map_err(|error| anyhow!("openclaw hook request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(anyhow!("openclaw hook returned HTTP {}", response.status()));
    }
    Ok(())
}

async fn forward_receipt_to_openclaw(
    http_client: &reqwest::Client,
    hook_url: &str,
    openclaw_runtime: &OpenclawRuntimeConfig,
    receipt: &ReceiptFrame,
) -> Result<()> {
    let mut request = http_client
        .post(hook_url)
        .header("content-type", "application/json")
        .header(
            "x-clawdentity-content-type",
            "application/vnd.clawdentity.receipt+json",
        )
        .header("x-clawdentity-to-agent-did", &receipt.to_agent_did)
        .header("x-clawdentity-verified", "true")
        .header("x-request-id", &receipt.original_frame_id)
        .json(&build_openclaw_receipt_payload(
            &openclaw_runtime.hook_path,
            receipt,
            openclaw_runtime.target_agent_id.as_deref(),
        ));

    if let Some(token) = openclaw_runtime
        .hook_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        request = request.header("x-openclaw-token", token);
    }

    let response = request
        .send()
        .await
        .map_err(|error| anyhow!("openclaw receipt hook request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(anyhow!(
            "openclaw receipt hook returned HTTP {}",
            response.status()
        ));
    }
    Ok(())
}

async fn persist_inbound_delivery_result(
    store: &SqliteStore,
    deliver: &DeliverFrame,
    delivery_result: std::result::Result<&(), &anyhow::Error>,
) -> Result<()> {
    let received_at_ms = now_utc_ms();
    append_received_inbound_event(store, deliver)?;

    if delivery_result.is_ok() {
        persist_successful_inbound_delivery(store, deliver)?;
        return Ok(());
    }

    persist_pending_inbound_delivery(store, deliver, received_at_ms, delivery_result)
}

fn append_received_inbound_event(store: &SqliteStore, deliver: &DeliverFrame) -> Result<()> {
    append_inbound_event(
        store,
        "received",
        Some(deliver.id.clone()),
        Some(
            json!({
                "frameId": deliver.id,
                "fromAgentDid": deliver.from_agent_did,
                "toAgentDid": deliver.to_agent_did,
            })
            .to_string(),
        ),
    )?;
    Ok(())
}

fn persist_successful_inbound_delivery(store: &SqliteStore, deliver: &DeliverFrame) -> Result<()> {
    if let Err(error) = delete_pending(store, &deliver.id) {
        tracing::warn!(
            error = %error,
            request_id = %deliver.id,
            "failed to clear pending inbound record after successful delivery"
        );
    }

    append_inbound_event(
        store,
        "delivered",
        Some(deliver.id.clone()),
        Some(json!({ "frameId": deliver.id }).to_string()),
    )?;
    Ok(())
}

fn persist_pending_inbound_delivery(
    store: &SqliteStore,
    deliver: &DeliverFrame,
    received_at_ms: i64,
    delivery_result: std::result::Result<&(), &anyhow::Error>,
) -> Result<()> {
    let payload_json = deliver.payload.to_string();
    let next_attempt_at_ms = received_at_ms + CONNECTOR_RETRY_DELAY_MS;
    let last_error = delivery_result
        .err()
        .map(ToString::to_string)
        .unwrap_or_else(|| "delivery failed".to_string());

    upsert_pending(
        store,
        InboundPendingItem {
            request_id: deliver.id.clone(),
            frame_id: deliver.id.clone(),
            from_agent_did: deliver.from_agent_did.clone(),
            to_agent_did: deliver.to_agent_did.clone(),
            payload_json: payload_json.clone(),
            payload_bytes: i64::try_from(payload_json.len()).unwrap_or(i64::MAX),
            received_at_ms,
            next_attempt_at_ms,
            attempt_count: 1,
            last_error: Some(last_error),
            last_attempt_at_ms: Some(received_at_ms),
            delivery_source: deliver.delivery_source.clone(),
            conversation_id: deliver.conversation_id.clone(),
            reply_to: deliver.reply_to.clone(),
        },
    )?;

    append_inbound_event(
        store,
        "pending",
        Some(deliver.id.clone()),
        Some(json!({ "frameId": deliver.id, "nextAttemptAtMs": next_attempt_at_ms }).to_string()),
    )?;
    Ok(())
}

async fn send_deliver_ack(
    relay_sender: &ConnectorClientSender,
    ack_id: &str,
    accepted: bool,
    reason: Option<String>,
) {
    let frame = ConnectorFrame::DeliverAck(DeliverAckFrame {
        v: CONNECTOR_FRAME_VERSION,
        id: new_frame_id(),
        ts: now_iso(),
        ack_id: ack_id.to_string(),
        accepted,
        reason,
    });

    if let Err(error) = relay_sender.send_frame(frame).await {
        tracing::warn!(error = %error, request_id = ack_id, "failed to send deliver ack");
    }
}
