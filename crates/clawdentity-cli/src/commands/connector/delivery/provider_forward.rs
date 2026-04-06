use std::collections::HashMap;

use anyhow::{Result, anyhow};
use clawdentity_core::{DeliverFrame, InboundMessage, get_provider};

use crate::commands::connector::ProviderInboundRuntime;

use super::SenderProfileHeaders;
use super::message_content::extract_message_content;

fn build_provider_metadata(
    deliver: &DeliverFrame,
    sender_profile: Option<&SenderProfileHeaders>,
    group_name: Option<&str>,
) -> HashMap<String, String> {
    let mut metadata = HashMap::new();

    if let Some(group_id) = trimmed_option(deliver.group_id.as_deref()) {
        metadata.insert("groupId".to_string(), group_id.to_string());
        metadata.insert("isGroupMessage".to_string(), "true".to_string());
    }
    insert_trimmed(&mut metadata, "groupName", group_name);
    insert_trimmed(
        &mut metadata,
        "conversationId",
        deliver.conversation_id.as_deref(),
    );
    insert_trimmed(&mut metadata, "replyTo", deliver.reply_to.as_deref());
    insert_trimmed(
        &mut metadata,
        "deliverySource",
        deliver.delivery_source.as_deref(),
    );
    insert_trimmed(
        &mut metadata,
        "contentType",
        deliver.content_type.as_deref(),
    );
    insert_trimmed(
        &mut metadata,
        "senderAgentName",
        sender_profile.and_then(|profile| profile.agent_name.as_deref()),
    );
    insert_trimmed(
        &mut metadata,
        "senderDisplayName",
        sender_profile.and_then(|profile| profile.display_name.as_deref()),
    );

    metadata
}

fn trimmed_option(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn insert_trimmed(metadata: &mut HashMap<String, String>, key: &str, value: Option<&str>) {
    if let Some(value) = trimmed_option(value) {
        metadata.insert(key.to_string(), value.to_string());
    }
}

pub(super) fn build_provider_inbound_message(
    deliver: &DeliverFrame,
    sender_profile: Option<&SenderProfileHeaders>,
    group_name: Option<&str>,
) -> InboundMessage {
    InboundMessage {
        sender_did: deliver.from_agent_did.clone(),
        recipient_did: deliver.to_agent_did.clone(),
        content: extract_message_content(&deliver.payload),
        request_id: Some(deliver.id.clone()),
        metadata: build_provider_metadata(deliver, sender_profile, group_name),
    }
}

pub(crate) async fn forward_deliver_to_provider(
    http_client: &reqwest::Client,
    runtime: &ProviderInboundRuntime,
    deliver: &DeliverFrame,
    sender_profile: Option<&SenderProfileHeaders>,
    group_name: Option<&str>,
) -> Result<()> {
    let message = build_provider_inbound_message(deliver, sender_profile, group_name);
    let request = {
        let provider = get_provider(&runtime.provider)
            .ok_or_else(|| anyhow!("unsupported provider `{}`", runtime.provider))?;
        provider.build_inbound_request(&message, runtime.webhook_token.as_deref())?
    };

    let mut outbound_request = http_client
        .post(&runtime.webhook_endpoint)
        .json(&request.body);
    for (header_name, header_value) in request.headers {
        outbound_request = outbound_request.header(header_name, header_value);
    }

    let response = outbound_request
        .send()
        .await
        .map_err(|error| anyhow!("{} webhook request failed: {error}", runtime.provider))?;
    if !response.status().is_success() {
        return Err(anyhow!(
            "{} webhook returned HTTP {}",
            runtime.provider,
            response.status()
        ));
    }
    Ok(())
}
