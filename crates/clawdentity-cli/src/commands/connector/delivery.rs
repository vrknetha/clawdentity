use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Result, anyhow};
use clawdentity_core::ConfigPathOptions;
use clawdentity_core::db::now_utc_ms;
use clawdentity_core::db_inbound::{
    InboundPendingItem, append_inbound_event, delete_pending, upsert_pending,
};
use clawdentity_core::http::client as create_http_client;
use clawdentity_core::{
    CONNECTOR_FRAME_VERSION, ConnectorClient, ConnectorClientSender, ConnectorFrame,
    DeliverAckFrame, DeliverFrame, EnqueueAckFrame, ReceiptFrame, ReceiptStatus, SqliteStore,
    new_frame_id, now_iso,
};
use serde_json::json;
use tokio::sync::watch;

use super::InboundDeliveryTarget;
use super::headers::{SenderProfileHeaders, build_openclaw_delivery_headers};
use super::receipts::{DeliveryReceiptPayload, DeliveryReceiptStatus, ReceiptOutboxHandle};
pub(super) use openclaw_payload::{build_openclaw_hook_payload, build_openclaw_receipt_payload};
use pair_accepted::{apply_pair_accepted_system_delivery, is_trusted_pair_accepted_delivery};
pub(super) use provider_forward::forward_deliver_to_provider;
use receipt_forward_queue::{
    PendingReceiptNotification, PendingReceiptQueue, enqueue_pending_receipt_notification,
    flush_pending_receipt_notifications,
};
pub(super) use retry::run_inbound_retry_loop;
#[cfg(test)]
pub(super) use retry::should_dead_letter_after_failure;
use sender_profile::resolve_sender_profile_for_delivery as resolve_sender_profile_for_delivery_inner;

mod message_content;
mod openclaw_payload;
mod pair_accepted;
mod provider_forward;
mod receipt_forward_queue;
mod retry;
mod sender_profile;

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
    pub inbound_target: InboundDeliveryTarget,
    pub outbound_inflight: OutboundInflightMap,
    pub pending_receipt_notifications: PendingReceiptQueueHandle,
}

pub(super) struct InboundRetryRuntime {
    pub options: ConfigPathOptions,
    pub agent_name: String,
    pub receipt_outbox: ReceiptOutboxHandle,
    pub store: SqliteStore,
    pub config_dir: PathBuf,
    pub inbound_target: InboundDeliveryTarget,
    pub pending_receipt_notifications: PendingReceiptQueueHandle,
    pub shutdown_rx: watch::Receiver<bool>,
}

struct InboundRuntimeContext<'a> {
    options: &'a ConfigPathOptions,
    agent_name: &'a str,
    store: &'a SqliteStore,
    config_dir: &'a Path,
    relay_sender: &'a ConnectorClientSender,
    http_client: &'a reqwest::Client,
    openclaw_hook_url: Option<&'a str>,
    inbound_target: &'a InboundDeliveryTarget,
    receipt_outbox: &'a ReceiptOutboxHandle,
    outbound_inflight: &'a OutboundInflightMap,
    pending_receipt_notifications: &'a PendingReceiptQueueHandle,
}

struct InboundRetryContext<'a> {
    options: &'a ConfigPathOptions,
    agent_name: &'a str,
    store: &'a SqliteStore,
    config_dir: &'a Path,
    http_client: &'a reqwest::Client,
    inbound_target: &'a InboundDeliveryTarget,
    receipt_outbox: &'a ReceiptOutboxHandle,
}

pub(super) async fn run_inbound_loop(
    mut connector_client: ConnectorClient,
    runtime: InboundLoopRuntime,
    mut shutdown_rx: watch::Receiver<bool>,
) -> Result<()> {
    let http_client = create_http_client()?;
    let openclaw_hook_url = match &runtime.inbound_target {
        InboundDeliveryTarget::Openclaw(runtime) => Some(runtime.hook_url()?),
        InboundDeliveryTarget::Provider(_) => None,
    };
    let context = InboundRuntimeContext {
        options: &runtime.options,
        agent_name: &runtime.agent_name,
        store: &runtime.store,
        config_dir: runtime.config_dir.as_path(),
        relay_sender: &runtime.relay_sender,
        http_client: &http_client,
        openclaw_hook_url: openclaw_hook_url.as_deref(),
        inbound_target: &runtime.inbound_target,
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
            if let (Some(hook_url), InboundDeliveryTarget::Openclaw(openclaw_runtime)) =
                (context.openclaw_hook_url, context.inbound_target)
            {
                enqueue_pending_receipt_notification(
                    context.pending_receipt_notifications,
                    PendingReceiptNotification::new(receipt),
                );
                flush_pending_receipt_notifications(
                    context.http_client,
                    hook_url,
                    openclaw_runtime,
                    context.pending_receipt_notifications,
                )
                .await;
            }
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

    if let (Some(hook_url), InboundDeliveryTarget::Openclaw(openclaw_runtime)) =
        (context.openclaw_hook_url, context.inbound_target)
    {
        let receipt = build_enqueue_rejected_receipt(ack.ack_id, to_agent_did, reason);
        enqueue_pending_receipt_notification(
            context.pending_receipt_notifications,
            PendingReceiptNotification::new(receipt),
        );
        flush_pending_receipt_notifications(
            context.http_client,
            hook_url,
            openclaw_runtime,
            context.pending_receipt_notifications,
        )
        .await;
    }
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
    let sender_profile = resolve_sender_profile_for_delivery(
        context.options,
        context.agent_name,
        context.store,
        &deliver.from_agent_did,
    )
    .await;
    let group_name = resolve_group_name_for_delivery(
        context.options,
        context.agent_name,
        deliver.group_id.as_deref(),
    )
    .await;
    let delivery_result = match system_delivery_result {
        Ok(_) => {
            forward_deliver_to_target(
                context.http_client,
                context.inbound_target,
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
    log_delivery_failure(context.inbound_target, &deliver, delivery_result.err());

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

fn log_delivery_failure(
    inbound_target: &InboundDeliveryTarget,
    deliver: &DeliverFrame,
    delivery_error: Option<anyhow::Error>,
) {
    if let Some(error) = delivery_error {
        tracing::warn!(
            error = %error,
            request_id = %deliver.id,
            to_agent_did = %deliver.to_agent_did,
            target = inbound_target.platform_name(),
            "failed to forward inbound payload to provider target"
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

async fn forward_deliver_to_target(
    http_client: &reqwest::Client,
    inbound_target: &InboundDeliveryTarget,
    deliver: &DeliverFrame,
    sender_profile: Option<&SenderProfileHeaders>,
    group_name: Option<&str>,
) -> Result<()> {
    match inbound_target {
        InboundDeliveryTarget::Openclaw(openclaw_runtime) => {
            let hook_url = openclaw_runtime.hook_url()?;
            forward_deliver_to_openclaw(
                http_client,
                &hook_url,
                openclaw_runtime,
                deliver,
                sender_profile,
                group_name,
            )
            .await
        }
        InboundDeliveryTarget::Provider(runtime) => {
            forward_deliver_to_provider(http_client, runtime, deliver, sender_profile, group_name)
                .await
        }
    }
}

pub(super) async fn forward_deliver_to_openclaw(
    http_client: &reqwest::Client,
    hook_url: &str,
    openclaw_runtime: &clawdentity_core::runtime_openclaw::OpenclawRuntimeConfig,
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

pub(super) async fn resolve_group_name_for_delivery(
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
            None
        }
    }
}

pub(super) async fn resolve_sender_profile_for_delivery(
    options: &ConfigPathOptions,
    agent_name: &str,
    store: &SqliteStore,
    sender_agent_did: &str,
) -> Option<SenderProfileHeaders> {
    resolve_sender_profile_for_delivery_inner(options, agent_name, store, sender_agent_did).await
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
