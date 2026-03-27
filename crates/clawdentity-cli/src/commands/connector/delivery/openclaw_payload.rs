use clawdentity_core::{DeliverFrame, ReceiptFrame, ReceiptStatus};
use serde_json::{Value, json};

use super::super::normalize_hook_path;

pub(crate) fn build_openclaw_hook_payload(
    hook_path: &str,
    deliver: &DeliverFrame,
    openclaw_target_agent_id: Option<&str>,
) -> Value {
    if normalize_hook_path(hook_path) == "/hooks/wake" {
        return build_openclaw_wake_payload(deliver);
    }

    build_openclaw_agent_payload(deliver, openclaw_target_agent_id)
}

pub(crate) fn build_openclaw_receipt_payload(hook_path: &str, receipt: &ReceiptFrame) -> Value {
    let summary = render_receipt_summary(receipt);
    let status = receipt_status_str(&receipt.status);
    let receipt_json = build_openclaw_receipt_metadata(receipt);

    if normalize_hook_path(hook_path) == "/hooks/wake" {
        return json!({
            "type": "clawdentity:receipt",
            "originalFrameId": receipt.original_frame_id,
            "toAgentDid": receipt.to_agent_did,
            "status": status,
            "reason": receipt.reason,
            "timestamp": receipt.ts,
            "text": summary,
            "message": summary,
            "mode": "now",
            "metadata": {
                "receipt": receipt_json,
            },
        });
    }

    json!({
        "type": "clawdentity:receipt",
        "originalFrameId": receipt.original_frame_id,
        "toAgentDid": receipt.to_agent_did,
        "status": status,
        "reason": receipt.reason,
        "timestamp": receipt.ts,
        "message": summary,
        "content": summary,
        "metadata": {
            "receipt": receipt_json,
        },
    })
}

fn build_openclaw_receipt_metadata(receipt: &ReceiptFrame) -> Value {
    json!({
        "type": "clawdentity:receipt",
        "originalFrameId": receipt.original_frame_id,
        "toAgentDid": receipt.to_agent_did,
        "status": receipt_status_str(&receipt.status),
        "reason": receipt.reason,
        "timestamp": receipt.ts,
    })
}

fn receipt_status_str(status: &ReceiptStatus) -> &'static str {
    match status {
        ReceiptStatus::ProcessedByOpenclaw => "processed_by_openclaw",
        ReceiptStatus::DeadLettered => "dead_lettered",
    }
}

fn render_receipt_summary(receipt: &ReceiptFrame) -> String {
    let mut lines = vec![
        format!(
            "Clawdentity delivery receipt: {}",
            match receipt.status {
                ReceiptStatus::ProcessedByOpenclaw => "processed_by_openclaw",
                ReceiptStatus::DeadLettered => "dead_lettered",
            }
        ),
        String::new(),
        format!("Request ID: {}", receipt.original_frame_id),
        format!("Recipient DID: {}", receipt.to_agent_did),
    ];

    if let Some(reason) = receipt
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        lines.push(format!("Reason: {reason}"));
    }
    lines.push(format!("Timestamp: {}", receipt.ts));
    lines.join("\n")
}

fn build_openclaw_agent_payload(
    deliver: &DeliverFrame,
    openclaw_target_agent_id: Option<&str>,
) -> Value {
    let message = extract_content(&deliver.payload);
    let mut payload = json!({
        "message": message,
        "content": message,
        "senderDid": deliver.from_agent_did,
        "recipientDid": deliver.to_agent_did,
        "requestId": deliver.id,
        "metadata": {
            "conversationId": deliver.conversation_id,
            "replyTo": deliver.reply_to,
            "payload": deliver.payload,
        },
    });
    if let Some(agent_id) = openclaw_target_agent_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        payload["agentId"] = Value::String(agent_id.to_string());
    }
    payload
}

fn build_openclaw_wake_payload(deliver: &DeliverFrame) -> Value {
    let wake_text = render_openclaw_wake_text(deliver);
    let session_id = deliver
        .payload
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let mut payload = json!({
        "message": wake_text,
        "text": wake_text,
        "mode": "now",
    });
    if let Some(session_id) = session_id {
        payload["sessionId"] = Value::String(session_id.to_string());
    }
    payload
}

fn render_openclaw_wake_text(deliver: &DeliverFrame) -> String {
    let message = extract_content(&deliver.payload);
    let mut lines = vec![format!(
        "Clawdentity peer message from {}",
        deliver.from_agent_did
    )];

    if !message.trim().is_empty() {
        lines.push(String::new());
        lines.push(message);
    }
    append_optional_line(
        &mut lines,
        Some(deliver.id.as_str()).filter(|value| !value.trim().is_empty()),
        "Request ID",
        true,
    );
    append_optional_line(
        &mut lines,
        deliver
            .conversation_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty()),
        "Conversation ID",
        false,
    );
    append_optional_line(
        &mut lines,
        deliver
            .reply_to
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty()),
        "Reply To",
        false,
    );

    lines.join("\n")
}

fn append_optional_line(lines: &mut Vec<String>, value: Option<&str>, label: &str, pad: bool) {
    if let Some(value) = value {
        if pad {
            lines.push(String::new());
        }
        lines.push(format!("{label}: {value}"));
    }
}

fn extract_content(payload: &Value) -> String {
    if let Some(content) = payload.get("content").and_then(Value::as_str) {
        return content.to_string();
    }
    if let Some(message) = payload.get("message").and_then(Value::as_str) {
        return message.to_string();
    }
    if let Some(text) = payload.get("text").and_then(Value::as_str) {
        return text.to_string();
    }
    if let Some(text) = payload.as_str() {
        return text.to_string();
    }
    payload.to_string()
}
