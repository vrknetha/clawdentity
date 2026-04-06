use clawdentity_core::{DeliverFrame, ReceiptFrame, ReceiptStatus};
use serde_json::{Value, json};

use super::super::headers::SenderProfileHeaders;
use super::super::normalize_hook_path;
use super::message_content::extract_message_content;

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
    let message_body = extract_message_content(&deliver.payload);
    let sender_agent_name = resolve_sender_agent_name(sender_profile);
    let sender_display_name = resolve_sender_display_name(sender_profile);
    let group_id = normalize_optional_non_empty(deliver.group_id.as_deref());
    let resolved_group_name = resolve_group_name(group_name);
    let sender_label = render_sender_label(
        sender_agent_name.as_deref(),
        sender_display_name.as_deref(),
        &deliver.from_agent_did,
    );
    let visible_message = render_visible_message(
        &sender_label,
        group_id.as_deref().and_then(|group_id| {
            resolve_group_label(resolved_group_name.as_deref(), Some(group_id))
        }),
        &message_body,
    );
    let mut payload = json!({
        "message": visible_message,
        "metadata": build_openclaw_message_metadata(
            deliver,
            sender_agent_name.as_deref(),
            sender_display_name.as_deref(),
            group_id.as_deref(),
            resolved_group_name.as_deref(),
        ),
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
    let sender_label = render_sender_label(
        resolve_sender_agent_name(sender_profile).as_deref(),
        resolve_sender_display_name(sender_profile).as_deref(),
        &deliver.from_agent_did,
    );
    let group_id = normalize_optional_non_empty(deliver.group_id.as_deref());
    let resolved_group_name = resolve_group_name(group_name);
    let wake_text = render_visible_message(
        &sender_label,
        group_id.as_deref().and_then(|group_id| {
            resolve_group_label(resolved_group_name.as_deref(), Some(group_id))
        }),
        &extract_message_content(&deliver.payload),
    );
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

fn render_visible_message(sender_label: &str, group_label: Option<String>, body: &str) -> String {
    if let Some(group_label) = group_label {
        return format!("[{group_label}] {sender_label}: {body}");
    }
    format!("{sender_label}: {body}")
}

fn resolve_group_label(group_name: Option<&str>, group_id: Option<&str>) -> Option<String> {
    group_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| {
            group_id
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
        })
}

fn build_openclaw_message_metadata(
    deliver: &DeliverFrame,
    sender_agent_name: Option<&str>,
    sender_display_name: Option<&str>,
    group_id: Option<&str>,
    group_name: Option<&str>,
) -> Value {
    let group = group_id.map(|group_id| {
        json!({
            "id": group_id,
            "name": group_name,
        })
    });
    json!({
        "sender": {
            "id": deliver.from_agent_did,
            "displayName": sender_display_name,
            "agentName": sender_agent_name,
        },
        "group": group,
        "conversation": {
            "id": deliver.conversation_id,
        },
        "reply": {
            "id": deliver.id,
            "to": deliver.reply_to,
        },
        "trust": {
            "verified": true,
        },
        "source": {
            "system": "clawdentity",
            "deliverySource": deliver.delivery_source,
        },
        "payload": deliver.payload,
    })
}

fn normalize_optional_non_empty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|candidate| !candidate.is_empty())
        .map(ToOwned::to_owned)
}

fn resolve_sender_agent_name(sender_profile: Option<&SenderProfileHeaders>) -> Option<String> {
    sender_profile.and_then(|profile| profile.agent_name.clone())
}

fn resolve_sender_display_name(sender_profile: Option<&SenderProfileHeaders>) -> Option<String> {
    sender_profile.and_then(|profile| profile.display_name.clone())
}

fn resolve_group_name(explicit_group_name: Option<&str>) -> Option<String> {
    explicit_group_name.and_then(|value| normalize_optional_non_empty(Some(value)))
}

fn render_sender_label(agent_name: Option<&str>, display_name: Option<&str>, did: &str) -> String {
    match (agent_name, display_name) {
        (_, Some(display_name)) => display_name.to_string(),
        (Some(agent_name), None) => agent_name.to_string(),
        (None, None) => did.to_string(),
    }
}
