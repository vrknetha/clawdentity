use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Result, anyhow};
use clawdentity_core::config::ConfigPathOptions;
use clawdentity_core::constants::AGENTS_DIR;
use clawdentity_core::db::now_utc_ms;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::{mpsc, oneshot};

use super::runtime_config::load_receipt_post_headers;

const RECEIPT_OUTBOX_DIR: &str = "receipt-outbox";
const RECEIPT_OUTBOX_FILE: &str = "receipt-outbox.json";
const RECEIPT_RETRY_INITIAL_MS: i64 = 1_000;
const RECEIPT_RETRY_MAX_MS: i64 = 60_000;
const RECEIPT_RETRY_BACKOFF_FACTOR: i64 = 2;
const RECEIPT_OUTBOX_COMMAND_BUFFER: usize = 128;

#[derive(Clone)]
pub(super) struct ReceiptDispatchRuntime {
    pub(super) options: ConfigPathOptions,
    pub(super) config_dir: PathBuf,
    pub(super) agent_name: String,
    pub(super) proxy_receipt_url: String,
}

#[derive(Clone)]
pub(super) struct ReceiptOutboxHandle {
    command_tx: mpsc::Sender<ReceiptOutboxCommand>,
}

enum ReceiptOutboxCommand {
    EnqueueAndFlush {
        payload: DeliveryReceiptPayload,
        respond_to: oneshot::Sender<Result<()>>,
    },
    FlushDue {
        respond_to: oneshot::Sender<Result<()>>,
    },
}

impl ReceiptOutboxHandle {
    pub(super) async fn enqueue_and_try_flush(
        &self,
        payload: DeliveryReceiptPayload,
    ) -> Result<()> {
        self.request(|respond_to| ReceiptOutboxCommand::EnqueueAndFlush {
            payload,
            respond_to,
        })
        .await
    }

    pub(super) async fn flush_due(&self) -> Result<()> {
        self.request(|respond_to| ReceiptOutboxCommand::FlushDue { respond_to })
            .await
    }

    async fn request(
        &self,
        build_command: impl FnOnce(oneshot::Sender<Result<()>>) -> ReceiptOutboxCommand,
    ) -> Result<()> {
        let (respond_to, response_rx) = oneshot::channel();
        self.command_tx
            .send(build_command(respond_to))
            .await
            .map_err(|_| anyhow!("receipt outbox worker is unavailable"))?;
        response_rx
            .await
            .map_err(|_| anyhow!("receipt outbox worker dropped command response"))?
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(super) enum DeliveryReceiptStatus {
    #[serde(rename = "processed_by_openclaw")]
    ProcessedByOpenclaw,
    #[serde(rename = "dead_lettered")]
    DeadLettered,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct DeliveryReceiptPayload {
    pub(super) request_id: String,
    pub(super) sender_agent_did: String,
    pub(super) recipient_agent_did: String,
    pub(super) status: DeliveryReceiptStatus,
    pub(super) reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct QueuedDeliveryReceipt {
    key: String,
    request_id: String,
    sender_agent_did: String,
    recipient_agent_did: String,
    status: DeliveryReceiptStatus,
    reason: Option<String>,
    attempt_count: i64,
    next_attempt_at_ms: i64,
    created_at_ms: i64,
}

fn outbox_path(config_dir: &Path, agent_name: &str) -> PathBuf {
    config_dir
        .join(AGENTS_DIR)
        .join(agent_name)
        .join(RECEIPT_OUTBOX_DIR)
        .join(RECEIPT_OUTBOX_FILE)
}

fn make_receipt_key(input: &DeliveryReceiptPayload) -> String {
    format!(
        "{}:{}",
        input.request_id,
        match input.status {
            DeliveryReceiptStatus::ProcessedByOpenclaw => "processed_by_openclaw",
            DeliveryReceiptStatus::DeadLettered => "dead_lettered",
        }
    )
}

fn load_outbox(path: &Path) -> Result<Vec<QueuedDeliveryReceipt>> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(anyhow!("failed to read receipt outbox: {error}")),
    };
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    let parsed = serde_json::from_str::<Vec<QueuedDeliveryReceipt>>(&raw)
        .map_err(|error| anyhow!("failed to parse receipt outbox: {error}"))?;
    Ok(parsed)
}

fn save_outbox(path: &Path, entries: &[QueuedDeliveryReceipt]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| anyhow!("failed to create receipt outbox directory: {error}"))?;
    }
    let body = serde_json::to_string_pretty(entries)
        .map_err(|error| anyhow!("failed to encode receipt outbox: {error}"))?;
    let tmp_path = path.with_extension(format!("tmp-{}-{}", std::process::id(), now_utc_ms()));
    fs::write(&tmp_path, format!("{body}\n"))
        .map_err(|error| anyhow!("failed to write receipt outbox temp file: {error}"))?;
    fs::rename(&tmp_path, path)
        .map_err(|error| anyhow!("failed to atomically replace receipt outbox file: {error}"))?;
    Ok(())
}

fn compute_retry_delay_ms(attempt_count: i64) -> i64 {
    let exponent = attempt_count.saturating_sub(1).max(0) as u32;
    let mut delay =
        RECEIPT_RETRY_INITIAL_MS.saturating_mul(RECEIPT_RETRY_BACKOFF_FACTOR.pow(exponent));
    if delay < 1 {
        delay = 1;
    }
    delay.min(RECEIPT_RETRY_MAX_MS)
}

async fn post_receipt(
    runtime: &ReceiptDispatchRuntime,
    http_client: &reqwest::Client,
    payload: &DeliveryReceiptPayload,
) -> Result<()> {
    let body = serde_json::to_vec(&json!({
        "requestId": payload.request_id,
        "senderAgentDid": payload.sender_agent_did,
        "recipientAgentDid": payload.recipient_agent_did,
        "status": match payload.status {
            DeliveryReceiptStatus::ProcessedByOpenclaw => "processed_by_openclaw",
            DeliveryReceiptStatus::DeadLettered => "dead_lettered",
        },
        "reason": payload.reason,
    }))
    .map_err(|error| anyhow!("failed to encode delivery receipt payload: {error}"))?;

    let headers = load_receipt_post_headers(
        &runtime.options,
        &runtime.agent_name,
        &runtime.proxy_receipt_url,
        &body,
    )?;

    let mut request = http_client
        .post(&runtime.proxy_receipt_url)
        .header("content-type", "application/json")
        .body(body);
    for (name, value) in headers {
        request = request.header(name, value);
    }

    let response = request
        .send()
        .await
        .map_err(|error| anyhow!("delivery receipt callback request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(anyhow!(
            "delivery receipt callback request failed with HTTP {}",
            response.status()
        ));
    }
    Ok(())
}

fn enqueue_receipt(
    runtime: &ReceiptDispatchRuntime,
    payload: DeliveryReceiptPayload,
) -> Result<()> {
    let path = outbox_path(&runtime.config_dir, &runtime.agent_name);
    let mut entries = load_outbox(&path)?;
    let now_ms = now_utc_ms();
    let key = make_receipt_key(&payload);
    let next = QueuedDeliveryReceipt {
        key: key.clone(),
        request_id: payload.request_id,
        sender_agent_did: payload.sender_agent_did,
        recipient_agent_did: payload.recipient_agent_did,
        status: payload.status,
        reason: payload.reason,
        attempt_count: 0,
        next_attempt_at_ms: now_ms,
        created_at_ms: now_ms,
    };
    if let Some(existing) = entries.iter_mut().find(|entry| entry.key == key) {
        let created_at_ms = existing.created_at_ms;
        *existing = QueuedDeliveryReceipt {
            created_at_ms,
            ..next
        };
    } else {
        entries.push(next);
    }
    save_outbox(&path, &entries)
}

async fn flush_due_receipts(
    runtime: &ReceiptDispatchRuntime,
    http_client: &reqwest::Client,
) -> Result<()> {
    let path = outbox_path(&runtime.config_dir, &runtime.agent_name);
    let now_ms = now_utc_ms();
    let mut entries = load_outbox(&path)?;
    if entries.is_empty() {
        return Ok(());
    }
    entries.sort_by_key(|entry| entry.created_at_ms);

    let mut retained: Vec<QueuedDeliveryReceipt> = Vec::with_capacity(entries.len());
    for mut entry in entries {
        if entry.next_attempt_at_ms > now_ms {
            retained.push(entry);
            continue;
        }
        let payload = DeliveryReceiptPayload {
            request_id: entry.request_id.clone(),
            sender_agent_did: entry.sender_agent_did.clone(),
            recipient_agent_did: entry.recipient_agent_did.clone(),
            status: entry.status.clone(),
            reason: entry.reason.clone(),
        };
        if let Err(error) = post_receipt(runtime, http_client, &payload).await {
            entry.attempt_count = entry.attempt_count.saturating_add(1);
            entry.next_attempt_at_ms = now_ms + compute_retry_delay_ms(entry.attempt_count);
            tracing::warn!(
                error = %error,
                request_id = %entry.request_id,
                attempt_count = entry.attempt_count,
                "failed to flush queued delivery receipt"
            );
            retained.push(entry);
        }
    }
    save_outbox(&path, &retained)?;
    Ok(())
}

pub(super) fn start_receipt_outbox_worker(
    runtime: ReceiptDispatchRuntime,
    http_client: reqwest::Client,
) -> ReceiptOutboxHandle {
    let (command_tx, mut command_rx) = mpsc::channel(RECEIPT_OUTBOX_COMMAND_BUFFER);
    tokio::spawn(async move {
        while let Some(command) = command_rx.recv().await {
            match command {
                ReceiptOutboxCommand::EnqueueAndFlush {
                    payload,
                    respond_to,
                } => {
                    let result = match enqueue_receipt(&runtime, payload) {
                        Ok(()) => flush_due_receipts(&runtime, &http_client).await,
                        Err(error) => Err(error),
                    };
                    let _ = respond_to.send(result);
                }
                ReceiptOutboxCommand::FlushDue { respond_to } => {
                    let result = flush_due_receipts(&runtime, &http_client).await;
                    let _ = respond_to.send(result);
                }
            }
        }
    });
    ReceiptOutboxHandle { command_tx }
}
