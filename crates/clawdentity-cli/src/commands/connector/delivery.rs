use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Result, anyhow};
use clawdentity_core::ConfigPathOptions;
use clawdentity_core::db::now_utc_ms;
use clawdentity_core::db_inbound::{
    InboundPendingItem, append_inbound_event, delete_pending, list_pending_due,
    mark_pending_attempt, move_pending_to_dead_letter, upsert_pending,
};
use clawdentity_core::http::client as create_http_client;
use clawdentity_core::runtime_openclaw::OpenclawRuntimeConfig;
use clawdentity_core::{
    CONNECTOR_FRAME_VERSION, ConnectorClient, ConnectorClientSender, ConnectorFrame,
    DeliverAckFrame, DeliverFrame, EnqueueAckFrame, ReceiptFrame, ReceiptStatus, SqliteStore,
    new_frame_id, now_iso,
};
use serde_json::{Value, json};
use tokio::sync::watch;

use super::headers::{
    SenderProfileHeaders, build_openclaw_delivery_headers, lookup_sender_profile_headers,
};
use super::receipts::{DeliveryReceiptPayload, DeliveryReceiptStatus, ReceiptOutboxHandle};
pub(super) use openclaw_payload::{build_openclaw_hook_payload, build_openclaw_receipt_payload};
use pair_accepted::{apply_pair_accepted_system_delivery, is_trusted_pair_accepted_delivery};
use receipt_forward_queue::{
    PendingReceiptNotification, PendingReceiptQueue, enqueue_pending_receipt_notification,
    flush_pending_receipt_notifications,
};

mod openclaw_payload;
mod pair_accepted;
mod receipt_forward_queue;

const CONNECTOR_RETRY_DELAY_MS: i64 = 5_000;
const INBOUND_RETRY_INTERVAL: Duration = Duration::from_secs(1);
const INBOUND_RETRY_BATCH_SIZE: usize = 50;
const INBOUND_MAX_ATTEMPTS: i64 = 3;

pub(super) type OutboundInflightMap = Arc<Mutex<HashMap<String, String>>>;
pub(super) type PendingReceiptQueueHandle = PendingReceiptQueue;

pub(super) struct InboundLoopRuntime {
    pub options: ConfigPathOptions,
    pub agent_name: String,
    pub receipt_outbox: ReceiptOutboxHandle,
    pub relay_sender: ConnectorClientSender,
    pub store: SqliteStore,
    pub config_dir: PathBuf,
    pub openclaw_runtime: OpenclawRuntimeConfig,
    pub outbound_inflight: OutboundInflightMap,
    pub pending_receipt_notifications: PendingReceiptQueueHandle,
}

struct InboundRuntimeContext<'a> {
    options: &'a ConfigPathOptions,
    agent_name: &'a str,
    store: &'a SqliteStore,
    config_dir: &'a Path,
    relay_sender: &'a ConnectorClientSender,
    http_client: &'a reqwest::Client,
    hook_url: &'a str,
    openclaw_runtime: &'a OpenclawRuntimeConfig,
    receipt_outbox: &'a ReceiptOutboxHandle,
    outbound_inflight: &'a OutboundInflightMap,
    pending_receipt_notifications: &'a PendingReceiptQueueHandle,
}

pub(super) async fn run_inbound_loop(
    mut connector_client: ConnectorClient,
    runtime: InboundLoopRuntime,
    mut shutdown_rx: watch::Receiver<bool>,
) -> Result<()> {
    let hook_url = runtime.openclaw_runtime.hook_url()?;
    let http_client = create_http_client()?;
    let context = InboundRuntimeContext {
        options: &runtime.options,
        agent_name: &runtime.agent_name,
        store: &runtime.store,
        config_dir: runtime.config_dir.as_path(),
        relay_sender: &runtime.relay_sender,
        http_client: &http_client,
        hook_url: &hook_url,
        openclaw_runtime: &runtime.openclaw_runtime,
        receipt_outbox: &runtime.receipt_outbox,
        outbound_inflight: &runtime.outbound_inflight,
        pending_receipt_notifications: &runtime.pending_receipt_notifications,
    };

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
                handle_connector_frame(frame, &context).await;
            }
        }
    }
}

async fn handle_connector_frame(frame: ConnectorFrame, context: &InboundRuntimeContext<'_>) {
    match frame {
        ConnectorFrame::Deliver(deliver) => {
            handle_deliver_frame(context, deliver).await;
        }
        ConnectorFrame::Receipt(receipt) => {
            enqueue_pending_receipt_notification(
                context.pending_receipt_notifications,
                PendingReceiptNotification::new(receipt),
            );
            flush_pending_receipt_notifications(
                context.http_client,
                context.hook_url,
                context.openclaw_runtime,
                context.pending_receipt_notifications,
            )
            .await;
        }
        ConnectorFrame::EnqueueAck(ack) => {
            handle_enqueue_ack(context, ack).await;
        }
        _ => {}
    }
}

async fn handle_enqueue_ack(context: &InboundRuntimeContext<'_>, ack: EnqueueAckFrame) {
    if ack.accepted {
        let _ = take_inflight_to_agent_did(context.outbound_inflight, &ack.ack_id);
        tracing::debug!(ack_id = %ack.ack_id, "relay accepted outbound enqueue frame");
        return;
    }

    let reason = ack.reason.as_deref().unwrap_or("unknown");
    let Some(to_agent_did) = take_inflight_to_agent_did(context.outbound_inflight, &ack.ack_id)
    else {
        tracing::warn!(
            ack_id = %ack.ack_id,
            reason,
            "relay rejected outbound enqueue frame but no inflight mapping was found; dropping receipt to avoid misrouting"
        );
        return;
    };

    tracing::warn!(
        ack_id = %ack.ack_id,
        reason,
        "relay rejected outbound enqueue frame"
    );

    let receipt = build_enqueue_rejected_receipt(ack.ack_id, to_agent_did, reason);
    enqueue_pending_receipt_notification(
        context.pending_receipt_notifications,
        PendingReceiptNotification::new(receipt),
    );
    flush_pending_receipt_notifications(
        context.http_client,
        context.hook_url,
        context.openclaw_runtime,
        context.pending_receipt_notifications,
    )
    .await;
}

fn take_inflight_to_agent_did(
    outbound_inflight: &OutboundInflightMap,
    ack_id: &str,
) -> Option<String> {
    outbound_inflight
        .lock()
        .ok()
        .and_then(|mut inflight| inflight.remove(ack_id))
}

fn build_enqueue_rejected_receipt(
    ack_id: String,
    to_agent_did: String,
    reason: &str,
) -> ReceiptFrame {
    ReceiptFrame {
        v: CONNECTOR_FRAME_VERSION,
        id: new_frame_id(),
        ts: now_iso(),
        original_frame_id: ack_id,
        to_agent_did,
        status: ReceiptStatus::DeadLettered,
        reason: Some(format!("relay rejected outbound enqueue frame: {reason}")),
    }
}

pub(super) async fn run_inbound_retry_loop(
    options: ConfigPathOptions,
    agent_name: String,
    receipt_outbox: ReceiptOutboxHandle,
    store: SqliteStore,
    config_dir: PathBuf,
    openclaw_runtime: OpenclawRuntimeConfig,
    pending_receipt_notifications: PendingReceiptQueueHandle,
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
                    &options,
                    &agent_name,
                    &store,
                    config_dir.as_path(),
                    &http_client,
                    &hook_url,
                    &openclaw_runtime,
                    &receipt_outbox,
                )
                .await;
                flush_pending_receipt_notifications(
                    &http_client,
                    &hook_url,
                    &openclaw_runtime,
                    &pending_receipt_notifications,
                )
                .await;
            }
        }
    }
}

async fn retry_due_inbound_deliveries(
    options: &ConfigPathOptions,
    agent_name: &str,
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
            options,
            agent_name,
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

#[allow(clippy::too_many_lines)]
async fn retry_pending_inbound_delivery(
    options: &ConfigPathOptions,
    agent_name: &str,
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
    if is_trusted_pair_accepted_delivery(&deliver)
        && let Err(error) = apply_pair_accepted_system_delivery(
            options,
            agent_name,
            store,
            config_dir,
            &mut deliver,
        )
        .await
    {
        handle_pending_retry_failure(store, receipt_outbox, &item, &error).await;
        return;
    }

    let sender_profile = lookup_sender_profile_headers(store, &item.from_agent_did);
    let group_name =
        resolve_group_name_for_delivery(options, agent_name, deliver.group_id.as_deref()).await;
    match forward_deliver_to_openclaw(
        http_client,
        hook_url,
        openclaw_runtime,
        &deliver,
        sender_profile.as_ref(),
        group_name.as_deref(),
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
        group_id: item.group_id.clone(),
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

#[allow(clippy::too_many_lines)]
async fn handle_deliver_frame(context: &InboundRuntimeContext<'_>, mut deliver: DeliverFrame) {
    let system_delivery_result = if is_trusted_pair_accepted_delivery(&deliver) {
        apply_pair_accepted_system_delivery(
            context.options,
            context.agent_name,
            context.store,
            context.config_dir,
            &mut deliver,
        )
        .await
    } else {
        Ok(false)
    };
    let sender_profile = lookup_sender_profile_headers(context.store, &deliver.from_agent_did);
    let group_name = resolve_group_name_for_delivery(
        context.options,
        context.agent_name,
        deliver.group_id.as_deref(),
    )
    .await;
    let delivery_result = match system_delivery_result {
        Ok(_) => {
            forward_deliver_to_openclaw(
                context.http_client,
                context.hook_url,
                context.openclaw_runtime,
                &deliver,
                sender_profile.as_ref(),
                group_name.as_deref(),
            )
            .await
        }
        Err(error) => Err(error),
    };
    let delivery_succeeded = delivery_result.is_ok();
    let persistence_result =
        persist_inbound_delivery_result(context.store, &deliver, delivery_result.as_ref()).await;
    log_persist_failure(&deliver.id, persistence_result.as_ref().err());

    let ack_reason = build_deliver_ack_reason(
        delivery_result.as_ref().err(),
        persistence_result.as_ref().err(),
    );
    let ack_accepted = ack_reason.is_none();
    send_deliver_ack(context.relay_sender, &deliver.id, ack_accepted, ack_reason).await;
    log_delivery_failure(&deliver, delivery_result.err());

    if delivery_succeeded {
        let _ = context
            .receipt_outbox
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
    group_name: Option<&str>,
) -> Result<()> {
    let mut request = http_client
        .post(hook_url)
        .json(&build_openclaw_hook_payload(
            &openclaw_runtime.hook_path,
            deliver,
            sender_profile,
            group_name,
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

async fn resolve_group_name_for_delivery(
    options: &ConfigPathOptions,
    agent_name: &str,
    group_id: Option<&str>,
) -> Option<String> {
    let group_id = group_id?.trim();
    if group_id.is_empty() {
        return None;
    }
    match super::runtime_config::fetch_group_name(options, agent_name, group_id).await {
        Ok(group_name) => Some(group_name),
        Err(error) => {
            tracing::warn!(
                error = %error,
                group_id,
                "failed to resolve group name for inbound delivery"
            );
            Some(group_id.to_string())
        }
    }
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
            group_id: deliver.group_id.clone(),
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
