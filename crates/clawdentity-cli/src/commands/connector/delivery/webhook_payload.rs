use clawdentity_core::{DeliverFrame, ReceiptFrame, ReceiptStatus};
use serde_json::{Map, Value, json};

use super::super::headers::SenderProfileHeaders;

pub(crate) fn build_delivery_webhook_payload(
    deliver: &DeliverFrame,
    sender_profile: Option<&SenderProfileHeaders>,
    group_name: Option<&str>,
) -> Value {
    let mut payload = Map::new();
    payload.insert("type".to_string(), Value::String("clawdentity.delivery.v1".to_string()));
    payload.insert("requestId".to_string(), Value::String(deliver.id.clone()));
    payload.insert(
        "fromAgentDid".to_string(),
        Value::String(deliver.from_agent_did.clone()),
    );
    payload.insert("toAgentDid".to_string(), Value::String(deliver.to_agent_did.clone()));
    payload.insert("payload".to_string(), deliver.payload.clone());

    if let Some(conversation_id) = optional_non_empty(deliver.conversation_id.as_deref()) {
        payload.insert(
            "conversationId".to_string(),
            Value::String(conversation_id.to_string()),
        );
    }
    if let Some(group_id) = optional_non_empty(deliver.group_id.as_deref()) {
        payload.insert("groupId".to_string(), Value::String(group_id.to_string()));
    }
    if let Some(sender_agent_name) = sender_profile
        .and_then(|profile| optional_non_empty(profile.agent_name.as_deref()))
    {
        payload.insert(
            "senderAgentName".to_string(),
            Value::String(sender_agent_name.to_string()),
        );
    }
    if let Some(sender_display_name) = sender_profile
        .and_then(|profile| optional_non_empty(profile.display_name.as_deref()))
    {
        payload.insert(
            "senderDisplayName".to_string(),
            Value::String(sender_display_name.to_string()),
        );
    }

    let mut relay_metadata = Map::new();
    if let Some(timestamp) = optional_non_empty(Some(&deliver.ts)) {
        relay_metadata.insert("timestamp".to_string(), Value::String(timestamp.to_string()));
    }
    if let Some(delivery_source) = optional_non_empty(deliver.delivery_source.as_deref()) {
        relay_metadata.insert(
            "deliverySource".to_string(),
            Value::String(delivery_source.to_string()),
        );
    }
    if let Some(content_type) = optional_non_empty(deliver.content_type.as_deref()) {
        relay_metadata.insert(
            "contentType".to_string(),
            Value::String(content_type.to_string()),
        );
    }
    if let Some(reply_to) = optional_non_empty(deliver.reply_to.as_deref()) {
        relay_metadata.insert("replyTo".to_string(), Value::String(reply_to.to_string()));
    }
    if let Some(group_name) = optional_non_empty(group_name) {
        relay_metadata.insert("groupName".to_string(), Value::String(group_name.to_string()));
    }
    if !relay_metadata.is_empty() {
        payload.insert("relayMetadata".to_string(), Value::Object(relay_metadata));
    }

    Value::Object(payload)
}

pub(crate) fn build_delivery_receipt_payload(receipt: &ReceiptFrame) -> Value {
    let mut payload = Map::new();
    payload.insert("type".to_string(), Value::String("clawdentity.receipt.v1".to_string()));
    payload.insert(
        "requestId".to_string(),
        Value::String(receipt.original_frame_id.clone()),
    );
    payload.insert("toAgentDid".to_string(), Value::String(receipt.to_agent_did.clone()));
    payload.insert(
        "status".to_string(),
        Value::String(receipt_status_str(&receipt.status).to_string()),
    );
    if let Some(reason) = optional_non_empty(receipt.reason.as_deref()) {
        payload.insert("reason".to_string(), Value::String(reason.to_string()));
    }
    if let Some(timestamp) = optional_non_empty(Some(&receipt.ts)) {
        payload.insert(
            "relayMetadata".to_string(),
            json!({
                "timestamp": timestamp,
            }),
        );
    }

    Value::Object(payload)
}

fn optional_non_empty(value: Option<&str>) -> Option<&str> {
    value
        .map(str::trim)
        .filter(|candidate| !candidate.is_empty())
}

fn receipt_status_str(status: &ReceiptStatus) -> &'static str {
    match status {
        ReceiptStatus::DeliveredToWebhook => "delivered_to_webhook",
        ReceiptStatus::DeadLettered => "dead_lettered",
    }
}
