use clawdentity_core::{DeliverFrame, ReceiptFrame, ReceiptStatus};
use serde_json::{Map, Value, json};

use super::super::headers::SenderProfileHeaders;

pub(crate) fn build_delivery_webhook_payload(
    deliver: &DeliverFrame,
    sender_profile: Option<&SenderProfileHeaders>,
    group_name: Option<&str>,
) -> Value {
    let mut payload = required_delivery_fields(deliver);
    insert_delivery_context_fields(&mut payload, deliver);
    insert_sender_profile_fields(&mut payload, sender_profile);
    insert_relay_metadata(&mut payload, deliver, group_name);
    Value::Object(payload)
}

fn required_delivery_fields(deliver: &DeliverFrame) -> Map<String, Value> {
    let mut payload = Map::new();
    payload.insert("type".to_string(), string_value("clawdentity.delivery.v1"));
    payload.insert("requestId".to_string(), Value::String(deliver.id.clone()));
    payload.insert(
        "fromAgentDid".to_string(),
        Value::String(deliver.from_agent_did.clone()),
    );
    payload.insert(
        "toAgentDid".to_string(),
        Value::String(deliver.to_agent_did.clone()),
    );
    payload.insert("payload".to_string(), deliver.payload.clone());
    payload
}

fn insert_delivery_context_fields(payload: &mut Map<String, Value>, deliver: &DeliverFrame) {
    insert_optional_string(
        payload,
        "conversationId",
        deliver.conversation_id.as_deref(),
    );
    insert_optional_string(payload, "groupId", deliver.group_id.as_deref());
}

fn insert_sender_profile_fields(
    payload: &mut Map<String, Value>,
    sender_profile: Option<&SenderProfileHeaders>,
) {
    let Some(sender_profile) = sender_profile else {
        return;
    };
    insert_optional_string(
        payload,
        "senderAgentName",
        sender_profile.agent_name.as_deref(),
    );
    insert_optional_string(
        payload,
        "senderDisplayName",
        sender_profile.display_name.as_deref(),
    );
}

fn insert_relay_metadata(
    payload: &mut Map<String, Value>,
    deliver: &DeliverFrame,
    group_name: Option<&str>,
) {
    let mut relay_metadata = Map::new();
    insert_optional_string(&mut relay_metadata, "timestamp", Some(&deliver.ts));
    insert_optional_string(
        &mut relay_metadata,
        "deliverySource",
        deliver.delivery_source.as_deref(),
    );
    insert_optional_string(
        &mut relay_metadata,
        "contentType",
        deliver.content_type.as_deref(),
    );
    insert_optional_string(&mut relay_metadata, "replyTo", deliver.reply_to.as_deref());
    insert_optional_string(&mut relay_metadata, "groupName", group_name);
    if !relay_metadata.is_empty() {
        payload.insert("relayMetadata".to_string(), Value::Object(relay_metadata));
    }
}

fn insert_optional_string(payload: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    if let Some(value) = optional_non_empty(value) {
        payload.insert(key.to_string(), string_value(value));
    }
}

fn string_value(value: &str) -> Value {
    Value::String(value.to_string())
}

pub(crate) fn build_delivery_receipt_payload(receipt: &ReceiptFrame) -> Value {
    let mut payload = Map::new();
    payload.insert(
        "type".to_string(),
        Value::String("clawdentity.receipt.v1".to_string()),
    );
    payload.insert(
        "requestId".to_string(),
        Value::String(receipt.original_frame_id.clone()),
    );
    payload.insert(
        "toAgentDid".to_string(),
        Value::String(receipt.to_agent_did.clone()),
    );
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
