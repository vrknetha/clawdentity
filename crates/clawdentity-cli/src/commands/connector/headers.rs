#[cfg(test)]
use clawdentity_core::DeliverFrame;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SenderProfileHeaders {
    pub(super) agent_name: Option<String>,
    pub(super) display_name: Option<String>,
}

fn sanitize_optional_header_value(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

pub(super) fn build_sender_profile_headers(
    agent_name: Option<String>,
    display_name: Option<String>,
) -> Option<SenderProfileHeaders> {
    let profile = SenderProfileHeaders {
        agent_name: sanitize_optional_header_value(agent_name),
        display_name: sanitize_optional_header_value(display_name),
    };
    if profile.agent_name.is_none() && profile.display_name.is_none() {
        None
    } else {
        Some(profile)
    }
}

#[cfg(test)]
pub(super) fn build_delivery_headers(
    deliver: &DeliverFrame,
    sender_profile: Option<&SenderProfileHeaders>,
    delivery_webhook_headers: &[(String, String)],
) -> Vec<(String, String)> {
    let mut capacity = 5 + delivery_webhook_headers.len();
    if sender_profile.is_some() {
        capacity += 2;
    }
    if deliver
        .group_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some()
    {
        capacity += 1;
    }
    let mut headers = Vec::with_capacity(capacity);
    headers.push((
        "content-type".to_string(),
        "application/vnd.clawdentity.delivery+json".to_string(),
    ));
    headers.push((
        "x-clawdentity-agent-did".to_string(),
        deliver.from_agent_did.clone(),
    ));
    headers.push((
        "x-clawdentity-to-agent-did".to_string(),
        deliver.to_agent_did.clone(),
    ));
    headers.push(("x-clawdentity-verified".to_string(), "true".to_string()));
    headers.push(("x-request-id".to_string(), deliver.id.clone()));

    if let Some(profile) = sender_profile {
        if let Some(agent_name) = profile.agent_name.as_deref() {
            headers.push((
                "x-clawdentity-agent-name".to_string(),
                agent_name.to_string(),
            ));
        }
        if let Some(display_name) = profile.display_name.as_deref() {
            headers.push((
                "x-clawdentity-display-name".to_string(),
                display_name.to_string(),
            ));
        }
    }
    if let Some(group_id) = deliver
        .group_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        headers.push(("x-clawdentity-group-id".to_string(), group_id.to_string()));
    }
    for (name, value) in delivery_webhook_headers {
        headers.push((name.clone(), value.clone()));
    }

    headers
}
