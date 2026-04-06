use anyhow::{Result, anyhow};
use clawdentity_core::db::now_utc_ms;
use clawdentity_core::db_inbound::{
    InboundPendingItem, append_inbound_event, delete_pending, list_pending_due,
    mark_pending_attempt, move_pending_to_dead_letter,
};
use clawdentity_core::{CONNECTOR_FRAME_VERSION, DeliverFrame, SqliteStore, now_iso};
use serde_json::{Value, json};

use super::{
    CONNECTOR_RETRY_DELAY_MS, DeliveryReceiptPayload, DeliveryReceiptStatus, INBOUND_MAX_ATTEMPTS,
    INBOUND_RETRY_BATCH_SIZE, INBOUND_RETRY_INTERVAL, InboundDeliveryTarget, InboundRetryContext,
    InboundRetryRuntime, ReceiptOutboxHandle, create_http_client,
    flush_pending_receipt_notifications, forward_deliver_to_target,
    resolve_group_name_for_delivery, resolve_sender_profile_for_delivery,
};
use super::{apply_pair_accepted_system_delivery, is_trusted_pair_accepted_delivery};

pub(crate) async fn run_inbound_retry_loop(runtime: InboundRetryRuntime) -> Result<()> {
    let http_client = create_http_client()?;
    let openclaw_hook_url = match &runtime.inbound_target {
        InboundDeliveryTarget::Openclaw(runtime) => Some(runtime.hook_url()?),
        InboundDeliveryTarget::Provider(_) => None,
    };
    let context = InboundRetryContext {
        options: &runtime.options,
        agent_name: &runtime.agent_name,
        store: &runtime.store,
        config_dir: runtime.config_dir.as_path(),
        http_client: &http_client,
        inbound_target: &runtime.inbound_target,
        receipt_outbox: &runtime.receipt_outbox,
    };
    let mut shutdown_rx = runtime.shutdown_rx;
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
                let _ = runtime.receipt_outbox.flush_due().await;
                retry_due_inbound_deliveries(&context).await;
                if let (
                    Some(hook_url),
                    InboundDeliveryTarget::Openclaw(openclaw_runtime),
                ) = (openclaw_hook_url.as_deref(), &runtime.inbound_target)
                {
                    flush_pending_receipt_notifications(
                        &http_client,
                        hook_url,
                        openclaw_runtime,
                        &runtime.pending_receipt_notifications,
                    )
                    .await;
                }
            }
        }
    }
}

async fn retry_due_inbound_deliveries(context: &InboundRetryContext<'_>) {
    let due_items = match list_pending_due(context.store, now_utc_ms(), INBOUND_RETRY_BATCH_SIZE) {
        Ok(items) => items,
        Err(error) => {
            tracing::warn!(error = %error, "failed to list pending inbound deliveries");
            return;
        }
    };

    for item in due_items {
        retry_pending_inbound_delivery(context, item).await;
    }
}

#[allow(clippy::too_many_lines)]
async fn retry_pending_inbound_delivery(
    context: &InboundRetryContext<'_>,
    item: InboundPendingItem,
) {
    let Ok(mut deliver) = build_deliver_from_pending(&item) else {
        dead_letter_invalid_pending_payload(context.store, context.receipt_outbox, &item).await;
        return;
    };
    if is_trusted_pair_accepted_delivery(&deliver)
        && let Err(error) = apply_pair_accepted_system_delivery(
            context.options,
            context.agent_name,
            context.store,
            context.config_dir,
            &mut deliver,
        )
        .await
    {
        handle_pending_retry_failure(context.store, context.receipt_outbox, &item, &error).await;
        return;
    }

    let sender_profile = resolve_sender_profile_for_delivery(
        context.options,
        context.agent_name,
        context.store,
        &item.from_agent_did,
    )
    .await;
    let group_name = resolve_group_name_for_delivery(
        context.options,
        context.agent_name,
        deliver.group_id.as_deref(),
    )
    .await;
    match forward_deliver_to_target(
        context.http_client,
        context.inbound_target,
        &deliver,
        sender_profile.as_ref(),
        group_name.as_deref(),
    )
    .await
    {
        Ok(()) => {
            record_retry_delivery_success(context.store, &item);
            let _ = context
                .receipt_outbox
                .enqueue_and_try_flush(DeliveryReceiptPayload {
                    request_id: item.request_id.clone(),
                    sender_agent_did: item.from_agent_did.clone(),
                    recipient_agent_did: item.to_agent_did.clone(),
                    status: DeliveryReceiptStatus::ProcessedByOpenclaw,
                    reason: None,
                })
                .await;
        }
        Err(error) => {
            handle_pending_retry_failure(context.store, context.receipt_outbox, &item, &error).await
        }
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

pub(crate) fn should_dead_letter_after_failure(current_attempt_count: i64) -> bool {
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
