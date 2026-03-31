use clawdentity_core::{DeliverFrame, ReceiptFrame, ReceiptStatus};
use serde_json::{Value, json};

use super::super::headers::SenderProfileHeaders;
use super::super::normalize_hook_path;

pub(crate) fn build_openclaw_hook_payload(
    hook_path: &str,
    deliver: &DeliverFrame,
    sender_profile: Option<&SenderProfileHeaders>,
    group_name: Option<&str>,
    openclaw_target_agent_id: Option<&str>,
) -> Value {
    if normalize_hook_path(hook_path) == "/hooks/wake" {
        return build_openclaw_wake_payload(deliver, sender_profile, group_name);
    }

    build_openclaw_agent_payload(
        deliver,
        sender_profile,
        group_name,
        openclaw_target_agent_id,
    )
}

pub(crate) fn build_openclaw_receipt_payload(
    hook_path: &str,
    receipt: &ReceiptFrame,
    openclaw_target_agent_id: Option<&str>,
) -> Value {
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

    let mut payload = json!({
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
    });
    if let Some(agent_id) = openclaw_target_agent_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        payload["agentId"] = Value::String(agent_id.to_string());
    }
    payload
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
    sender_profile: Option<&SenderProfileHeaders>,
    group_name: Option<&str>,
    openclaw_target_agent_id: Option<&str>,
) -> Value {
    let message = extract_content(&deliver.payload);
    let sender_agent_name = resolve_sender_agent_name(deliver, sender_profile);
    let sender_display_name = resolve_sender_display_name(deliver, sender_profile);
    let group_id = normalize_optional_non_empty(deliver.group_id.as_deref());
    let resolved_group_name = resolve_group_name(deliver, group_name, group_id.as_deref());
    let is_group_message = group_id.is_some();
    let mut payload = json!({
        "message": message,
        "senderDid": deliver.from_agent_did,
        "senderAgentName": sender_agent_name,
        "senderDisplayName": sender_display_name,
        "recipientDid": deliver.to_agent_did,
        "groupId": group_id,
        "groupName": resolved_group_name,
        "isGroupMessage": is_group_message,
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

fn build_openclaw_wake_payload(
    deliver: &DeliverFrame,
    sender_profile: Option<&SenderProfileHeaders>,
    group_name: Option<&str>,
) -> Value {
    let wake_text = render_openclaw_wake_text(deliver, sender_profile, group_name);
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

#[allow(clippy::too_many_lines)]
fn render_openclaw_wake_text(
    deliver: &DeliverFrame,
    sender_profile: Option<&SenderProfileHeaders>,
    group_name: Option<&str>,
) -> String {
    let message = extract_content(&deliver.payload);
    let sender_agent_name = resolve_sender_agent_name(deliver, sender_profile);
    let sender_display_name = resolve_sender_display_name(deliver, sender_profile);
    let sender_label = render_sender_label(
        sender_agent_name.as_deref(),
        sender_display_name.as_deref(),
        &deliver.from_agent_did,
    );
    let group_id = normalize_optional_non_empty(deliver.group_id.as_deref());
    let resolved_group_name = resolve_group_name(deliver, group_name, group_id.as_deref());
    let headline = if group_id.is_some() {
        let group_label = resolved_group_name
            .or(group_id)
            .unwrap_or_else(|| "unknown-group".to_string());
        format!("Message in {group_label} from {sender_label}")
    } else {
        format!("Message from {sender_label}")
    };
    let mut lines = vec![headline];

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

fn normalize_optional_non_empty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|candidate| !candidate.is_empty())
        .map(ToOwned::to_owned)
}

fn resolve_sender_agent_name(
    deliver: &DeliverFrame,
    sender_profile: Option<&SenderProfileHeaders>,
) -> Option<String> {
    sender_profile
        .and_then(|profile| profile.agent_name.clone())
        .or_else(|| {
            normalize_optional_non_empty(
                deliver
                    .payload
                    .get("senderAgentName")
                    .and_then(Value::as_str)
                    .or_else(|| deliver.payload.get("agentName").and_then(Value::as_str)),
            )
        })
}

fn resolve_sender_display_name(
    deliver: &DeliverFrame,
    sender_profile: Option<&SenderProfileHeaders>,
) -> Option<String> {
    sender_profile
        .and_then(|profile| profile.display_name.clone())
        .or_else(|| {
            normalize_optional_non_empty(
                deliver
                    .payload
                    .get("senderDisplayName")
                    .and_then(Value::as_str)
                    .or_else(|| deliver.payload.get("displayName").and_then(Value::as_str)),
            )
        })
}

fn resolve_group_name(
    deliver: &DeliverFrame,
    explicit_group_name: Option<&str>,
    group_id: Option<&str>,
) -> Option<String> {
    explicit_group_name
        .and_then(|value| normalize_optional_non_empty(Some(value)))
        .or_else(|| {
            normalize_optional_non_empty(deliver.payload.get("groupName").and_then(Value::as_str))
        })
        .or_else(|| group_id.map(ToOwned::to_owned))
}

fn render_sender_label(agent_name: Option<&str>, display_name: Option<&str>, did: &str) -> String {
    match (agent_name, display_name) {
        (Some(agent_name), Some(display_name)) => format!("{agent_name} ({display_name})"),
        (Some(agent_name), None) => agent_name.to_string(),
        (None, Some(display_name)) => display_name.to_string(),
        (None, None) => did.to_string(),
    }
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
