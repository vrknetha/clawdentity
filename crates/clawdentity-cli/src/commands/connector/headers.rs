use clawdentity_core::{DeliverFrame, SqliteStore, get_peer_by_did};

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

pub(super) fn lookup_sender_profile_headers(
    store: &SqliteStore,
    sender_agent_did: &str,
) -> Option<SenderProfileHeaders> {
    let sender_agent_did = sender_agent_did.trim();
    if sender_agent_did.is_empty() {
        return None;
    }

    match get_peer_by_did(store, sender_agent_did) {
        Ok(Some(peer)) => {
            let profile = SenderProfileHeaders {
                agent_name: sanitize_optional_header_value(peer.agent_name),
                display_name: sanitize_optional_header_value(peer.display_name),
            };
            if profile.agent_name.is_none() && profile.display_name.is_none() {
                None
            } else {
                Some(profile)
            }
        }
        Ok(None) => None,
        Err(error) => {
            tracing::warn!(
                error = %error,
                sender_agent_did,
                "failed to resolve sender profile for inbound delivery"
            );
            None
        }
    }
}

pub(super) fn build_openclaw_delivery_headers(
    deliver: &DeliverFrame,
    sender_profile: Option<&SenderProfileHeaders>,
    openclaw_hook_token: Option<&str>,
) -> Vec<(&'static str, String)> {
    let mut headers = vec![
        ("content-type", "application/json".to_string()),
        ("x-clawdentity-agent-did", deliver.from_agent_did.clone()),
        ("x-clawdentity-to-agent-did", deliver.to_agent_did.clone()),
        ("x-clawdentity-verified", "true".to_string()),
        ("x-request-id", deliver.id.clone()),
    ];

    if let Some(profile) = sender_profile {
        if let Some(agent_name) = profile.agent_name.as_deref() {
            headers.push(("x-clawdentity-agent-name", agent_name.to_string()));
        }
        if let Some(display_name) = profile.display_name.as_deref() {
            headers.push(("x-clawdentity-display-name", display_name.to_string()));
        }
    }
    if let Some(group_id) = deliver
        .group_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        headers.push(("x-clawdentity-group-id", group_id.to_string()));
    }

    if let Some(token) = openclaw_hook_token.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    }) {
        headers.push(("x-openclaw-token", token.to_string()));
    }

    headers
}
