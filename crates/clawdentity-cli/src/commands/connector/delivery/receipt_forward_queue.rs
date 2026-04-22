use std::sync::{Arc, Mutex};

use anyhow::{Result, anyhow};
use clawdentity_core::ReceiptFrame;
use clawdentity_core::db::now_utc_ms;
use clawdentity_core::runtime_webhook::DeliveryWebhookRuntimeConfig;

use super::build_delivery_receipt_payload;

const RECEIPT_FORWARD_RETRY_INITIAL_DELAY_MS: i64 = 1_000;
const RECEIPT_FORWARD_RETRY_MAX_DELAY_MS: i64 = 60_000;
const RECEIPT_FORWARD_RETRY_BACKOFF_FACTOR: i64 = 2;
const RECEIPT_FORWARD_MAX_ATTEMPTS: i64 = 30;
const RECEIPT_FORWARD_MAX_AGE_MS: i64 = 24 * 60 * 60 * 1_000;
const RECEIPT_FORWARD_MAX_PENDING: usize = 10_000;

pub(in crate::commands::connector) type PendingReceiptQueue =
    Arc<Mutex<Vec<PendingReceiptNotification>>>;

#[derive(Clone, Debug)]
pub(in crate::commands::connector) struct PendingReceiptNotification {
    pub attempt_count: i64,
    pub created_at_ms: i64,
    pub next_attempt_at_ms: i64,
    pub receipt: ReceiptFrame,
}

impl PendingReceiptNotification {
    pub(in crate::commands::connector) fn new(receipt: ReceiptFrame) -> Self {
        let now_ms = now_utc_ms();
        Self {
            attempt_count: 0,
            created_at_ms: now_ms,
            next_attempt_at_ms: now_ms,
            receipt,
        }
    }
}

pub(in crate::commands::connector) fn enqueue_pending_receipt_notification(
    queue: &PendingReceiptQueue,
    notification: PendingReceiptNotification,
) {
    if let Ok(mut pending) = queue.lock() {
        prune_pending_queue(&mut pending, now_utc_ms());
        if pending.len() >= RECEIPT_FORWARD_MAX_PENDING {
            tracing::warn!(
                max_pending = RECEIPT_FORWARD_MAX_PENDING,
                "dropping pending receipt notification because queue is full"
            );
            return;
        }
        pending.push(notification);
    } else {
        tracing::warn!("failed to queue pending receipt notification: lock poisoned");
    }
}

pub(in crate::commands::connector) async fn flush_pending_receipt_notifications(
    http_client: &reqwest::Client,
    hook_url: &str,
    delivery_webhook_runtime: &DeliveryWebhookRuntimeConfig,
    queue: &PendingReceiptQueue,
) {
    let now_ms = now_utc_ms();
    let Some(due_notifications) = take_due_notifications(queue, now_ms) else {
        return;
    };

    let mut retry_notifications: Vec<PendingReceiptNotification> = Vec::new();
    for mut notification in due_notifications {
        if should_drop_notification(&notification, now_ms) {
            continue;
        }
        if let Err(error) = forward_receipt_to_webhook(
            http_client,
            hook_url,
            delivery_webhook_runtime,
            &notification.receipt,
        )
        .await
        {
            notification.attempt_count += 1;
            notification.next_attempt_at_ms =
                now_utc_ms() + compute_receipt_retry_delay_ms(notification.attempt_count);
            tracing::warn!(
                error = %error,
                request_id = %notification.receipt.original_frame_id,
                status = ?notification.receipt.status,
                next_attempt_at_ms = notification.next_attempt_at_ms,
                "failed to forward receipt payload to delivery webhook; queued for retry"
            );
            retry_notifications.push(notification);
        }
    }

    requeue_notifications(queue, retry_notifications);
}

fn prune_pending_queue(pending: &mut Vec<PendingReceiptNotification>, now_ms: i64) {
    pending.retain(|item| {
        item.attempt_count < RECEIPT_FORWARD_MAX_ATTEMPTS
            && now_ms.saturating_sub(item.created_at_ms) <= RECEIPT_FORWARD_MAX_AGE_MS
    });
}

fn take_due_notifications(
    queue: &PendingReceiptQueue,
    now_ms: i64,
) -> Option<Vec<PendingReceiptNotification>> {
    let Ok(mut pending) = queue.lock() else {
        tracing::warn!("failed to flush pending receipt notifications: lock poisoned");
        return None;
    };

    let mut due = Vec::new();
    let mut future = Vec::new();
    for notification in pending.drain(..) {
        if notification.next_attempt_at_ms <= now_ms {
            due.push(notification);
        } else {
            future.push(notification);
        }
    }
    *pending = future;

    if due.is_empty() { None } else { Some(due) }
}

fn should_drop_notification(notification: &PendingReceiptNotification, now_ms: i64) -> bool {
    if notification.attempt_count >= RECEIPT_FORWARD_MAX_ATTEMPTS {
        tracing::warn!(
            request_id = %notification.receipt.original_frame_id,
            status = ?notification.receipt.status,
            attempt_count = notification.attempt_count,
            "dropping pending receipt notification after max retry attempts"
        );
        return true;
    }
    if now_ms.saturating_sub(notification.created_at_ms) > RECEIPT_FORWARD_MAX_AGE_MS {
        tracing::warn!(
            request_id = %notification.receipt.original_frame_id,
            status = ?notification.receipt.status,
            age_ms = now_ms.saturating_sub(notification.created_at_ms),
            "dropping pending receipt notification after max age"
        );
        return true;
    }
    false
}

fn requeue_notifications(
    queue: &PendingReceiptQueue,
    mut retry_notifications: Vec<PendingReceiptNotification>,
) {
    if retry_notifications.is_empty() {
        return;
    }
    if let Ok(mut pending) = queue.lock() {
        let capacity = RECEIPT_FORWARD_MAX_PENDING.saturating_sub(pending.len());
        if retry_notifications.len() > capacity {
            tracing::warn!(
                dropped = retry_notifications.len() - capacity,
                max_pending = RECEIPT_FORWARD_MAX_PENDING,
                "dropping pending receipt retries because queue is full"
            );
            retry_notifications.truncate(capacity);
        }
        pending.extend(retry_notifications);
    } else {
        tracing::warn!("failed to requeue pending receipt notifications: lock poisoned");
    }
}

fn compute_receipt_retry_delay_ms(attempt_count: i64) -> i64 {
    let exponent = attempt_count.saturating_sub(1) as u32;
    let factor = RECEIPT_FORWARD_RETRY_BACKOFF_FACTOR.saturating_pow(exponent);
    (RECEIPT_FORWARD_RETRY_INITIAL_DELAY_MS.saturating_mul(factor))
        .clamp(1, RECEIPT_FORWARD_RETRY_MAX_DELAY_MS)
}

async fn forward_receipt_to_webhook(
    http_client: &reqwest::Client,
    hook_url: &str,
    delivery_webhook_runtime: &DeliveryWebhookRuntimeConfig,
    receipt: &ReceiptFrame,
) -> Result<()> {
    let mut request = http_client
        .post(hook_url)
        .header("content-type", "application/vnd.clawdentity.receipt+json")
        .header("x-clawdentity-to-agent-did", &receipt.to_agent_did)
        .header("x-clawdentity-verified", "true")
        .header("x-request-id", &receipt.original_frame_id)
        .json(&build_delivery_receipt_payload(receipt));

    for (name, value) in &delivery_webhook_runtime.webhook_headers {
        request = request.header(name, value);
    }

    let response = request
        .send()
        .await
        .map_err(|error| anyhow!("delivery webhook receipt request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(anyhow!(
            "delivery webhook receipt request returned HTTP {}",
            response.status()
        ));
    }
    Ok(())
}
