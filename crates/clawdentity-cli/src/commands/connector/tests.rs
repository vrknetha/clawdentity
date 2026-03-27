use anyhow::anyhow;
use chrono::{Duration as ChronoDuration, Utc};
use clawdentity_core::agent::AgentAuthRecord;
use clawdentity_core::{DeliverFrame, ReceiptFrame, ReceiptStatus};
use serde_json::json;
use std::collections::HashMap;

use super::runtime_config::{agent_access_requires_refresh, normalize_proxy_ws_url};
use super::{
    SenderProfileHeaders, build_deliver_ack_reason, build_openclaw_delivery_headers,
    build_openclaw_hook_payload, build_openclaw_receipt_payload, normalize_hook_path,
    should_dead_letter_after_failure,
};

#[test]
fn normalizes_hook_path_with_leading_slash() {
    assert_eq!(normalize_hook_path("hooks/agent"), "/hooks/agent");
    assert_eq!(normalize_hook_path("/hooks/agent"), "/hooks/agent");
    assert_eq!(normalize_hook_path("hooks/wake"), "/hooks/wake");
    assert_eq!(normalize_hook_path("/hooks/wake"), "/hooks/wake");
}

#[test]
fn normalizes_proxy_http_url_to_ws_connect_route() {
    let resolved = normalize_proxy_ws_url("http://127.0.0.1:13371").expect("proxy ws url");
    assert_eq!(resolved, "ws://127.0.0.1:13371/v1/relay/connect");
}

#[test]
fn preserves_ws_url_when_already_websocket() {
    let resolved =
        normalize_proxy_ws_url("wss://proxy.example/v1/relay/connect").expect("proxy ws url");
    assert_eq!(resolved, "wss://proxy.example/v1/relay/connect");
}

#[test]
fn deliver_ack_reason_is_none_when_delivery_and_persistence_succeed() {
    let reason = build_deliver_ack_reason(None, None);
    assert!(reason.is_none());
}

#[test]
fn deliver_ack_reason_is_none_when_delivery_succeeds_but_persistence_fails() {
    let persistence_error = anyhow!("sqlite unavailable");
    let reason = build_deliver_ack_reason(None, Some(&persistence_error));
    assert!(reason.is_none());
}

#[test]
fn deliver_ack_reason_combines_delivery_and_persistence_failures() {
    let delivery_error = anyhow!("openclaw hook returned HTTP 500");
    let persistence_error = anyhow!("sqlite unavailable");
    let reason = build_deliver_ack_reason(Some(&delivery_error), Some(&persistence_error));
    assert_eq!(
        reason.as_deref(),
        Some(
            "openclaw hook returned HTTP 500; failed to persist inbound delivery result: sqlite unavailable"
        )
    );
}

#[test]
fn deliver_ack_reason_is_none_when_delivery_failed_but_retry_was_persisted() {
    let delivery_error = anyhow!("openclaw hook returned HTTP 500");
    let reason = build_deliver_ack_reason(Some(&delivery_error), None);
    assert!(reason.is_none());
}

#[test]
fn openclaw_delivery_headers_include_profile_headers_when_available() {
    let deliver = DeliverFrame {
        v: 1,
        id: "req-headers-1".to_string(),
        ts: "2026-03-20T05:55:00Z".to_string(),
        from_agent_did: "did:cdi:test:agent:sender".to_string(),
        to_agent_did: "did:cdi:test:agent:recipient".to_string(),
        payload: json!({ "message": "hello" }),
        content_type: Some("application/json".to_string()),
        conversation_id: None,
        reply_to: None,
    };
    let sender_profile = SenderProfileHeaders {
        agent_name: Some("sender-assistant".to_string()),
        human_name: Some("Sender Human".to_string()),
    };

    let headers =
        build_openclaw_delivery_headers(&deliver, Some(&sender_profile), Some("  token-1 "));
    let header_map: HashMap<&str, String> = headers.into_iter().collect();

    assert_eq!(
        header_map
            .get("x-clawdentity-agent-did")
            .map(String::as_str),
        Some("did:cdi:test:agent:sender")
    );
    assert_eq!(
        header_map
            .get("x-clawdentity-to-agent-did")
            .map(String::as_str),
        Some("did:cdi:test:agent:recipient")
    );
    assert_eq!(
        header_map.get("x-clawdentity-verified").map(String::as_str),
        Some("true")
    );
    assert_eq!(
        header_map.get("x-request-id").map(String::as_str),
        Some("req-headers-1")
    );
    assert_eq!(
        header_map
            .get("x-clawdentity-agent-name")
            .map(String::as_str),
        Some("sender-assistant")
    );
    assert_eq!(
        header_map
            .get("x-clawdentity-human-name")
            .map(String::as_str),
        Some("Sender Human")
    );
    assert_eq!(
        header_map.get("x-openclaw-token").map(String::as_str),
        Some("token-1")
    );
}

#[test]
fn openclaw_delivery_headers_omit_profile_headers_when_missing() {
    let deliver = DeliverFrame {
        v: 1,
        id: "req-headers-2".to_string(),
        ts: "2026-03-20T05:55:00Z".to_string(),
        from_agent_did: "did:cdi:test:agent:sender".to_string(),
        to_agent_did: "did:cdi:test:agent:recipient".to_string(),
        payload: json!({ "message": "hello" }),
        content_type: Some("application/json".to_string()),
        conversation_id: None,
        reply_to: None,
    };

    let headers = build_openclaw_delivery_headers(&deliver, None, None);
    let header_map: HashMap<&str, String> = headers.into_iter().collect();
    assert_eq!(
        header_map.get("x-clawdentity-verified").map(String::as_str),
        Some("true")
    );
    assert!(header_map.get("x-clawdentity-agent-name").is_none());
    assert!(header_map.get("x-clawdentity-human-name").is_none());
    assert!(header_map.get("x-openclaw-token").is_none());
}

#[test]
fn openclaw_hook_payload_uses_message_field() {
    let deliver = DeliverFrame {
        v: 1,
        id: "req-1".to_string(),
        ts: "2026-03-20T05:55:00Z".to_string(),
        from_agent_did: "did:cdi:test:agent:sender".to_string(),
        to_agent_did: "did:cdi:test:agent:recipient".to_string(),
        payload: json!({
            "content": "hello from alpha",
            "kind": "relay-test",
        }),
        content_type: Some("application/json".to_string()),
        conversation_id: Some("conv-1".to_string()),
        reply_to: Some("reply-1".to_string()),
    };

    let payload = build_openclaw_hook_payload("/hooks/agent", &deliver);
    assert_eq!(
        payload.get("message").and_then(|value| value.as_str()),
        Some("hello from alpha")
    );
    assert_eq!(
        payload.get("content").and_then(|value| value.as_str()),
        Some("hello from alpha")
    );
    assert_eq!(
        payload
            .get("metadata")
            .and_then(|value| value.get("payload")),
        Some(&deliver.payload)
    );
}

#[test]
fn openclaw_hook_payload_stringifies_non_string_payloads() {
    let deliver = DeliverFrame {
        v: 1,
        id: "req-2".to_string(),
        ts: "2026-03-20T05:55:00Z".to_string(),
        from_agent_did: "did:cdi:test:agent:sender".to_string(),
        to_agent_did: "did:cdi:test:agent:recipient".to_string(),
        payload: json!({
            "structured": true,
            "count": 2,
        }),
        content_type: Some("application/json".to_string()),
        conversation_id: None,
        reply_to: None,
    };

    let payload = build_openclaw_hook_payload("/hooks/agent", &deliver);
    assert_eq!(
        payload.get("message").and_then(|value| value.as_str()),
        Some("{\"count\":2,\"structured\":true}")
    );
}

#[test]
fn openclaw_wake_payload_preserves_explicit_session_id() {
    let deliver = DeliverFrame {
        v: 1,
        id: "req-3".to_string(),
        ts: "2026-03-20T05:55:00Z".to_string(),
        from_agent_did: "did:cdi:test:agent:sender".to_string(),
        to_agent_did: "did:cdi:test:agent:recipient".to_string(),
        payload: json!({
            "content": "hello from alpha",
            "sessionId": "main",
        }),
        content_type: Some("application/json".to_string()),
        conversation_id: Some("conv-1".to_string()),
        reply_to: Some("reply-1".to_string()),
    };

    let payload = build_openclaw_hook_payload("/hooks/wake", &deliver);
    assert_eq!(
        payload.get("mode").and_then(|value| value.as_str()),
        Some("now")
    );
    assert_eq!(
        payload.get("message").and_then(|value| value.as_str()),
        payload.get("text").and_then(|value| value.as_str())
    );
    assert_eq!(
        payload.get("sessionId").and_then(|value| value.as_str()),
        Some("main")
    );
    let text = payload
        .get("text")
        .and_then(|value| value.as_str())
        .expect("wake text");
    assert!(text.contains("Clawdentity peer message from did:cdi:test:agent:sender"));
    assert!(text.contains("hello from alpha"));
    assert!(text.contains("Request ID: req-3"));
    assert!(text.contains("Conversation ID: conv-1"));
    assert!(text.contains("Reply To: reply-1"));
}

#[test]
fn openclaw_wake_payload_omits_default_session_override() {
    let deliver = DeliverFrame {
        v: 1,
        id: "req-4".to_string(),
        ts: "2026-03-20T05:55:00Z".to_string(),
        from_agent_did: "did:cdi:test:agent:sender".to_string(),
        to_agent_did: "did:cdi:test:agent:recipient".to_string(),
        payload: json!({
            "message": "plain peer text",
        }),
        content_type: Some("application/json".to_string()),
        conversation_id: None,
        reply_to: None,
    };

    let payload = build_openclaw_hook_payload("/hooks/wake", &deliver);
    assert!(payload.get("sessionId").is_none());
    assert_eq!(
        payload.get("message").and_then(|value| value.as_str()),
        payload.get("text").and_then(|value| value.as_str())
    );
    assert_eq!(
        payload.get("text").and_then(|value| value.as_str()),
        Some(
            "Clawdentity peer message from did:cdi:test:agent:sender\n\nplain peer text\n\nRequest ID: req-4"
        )
    );
}

#[test]
fn openclaw_wake_payload_prefers_message_field_from_sender_transform() {
    let deliver = DeliverFrame {
        v: 1,
        id: "req-5".to_string(),
        ts: "2026-03-20T05:55:00Z".to_string(),
        from_agent_did: "did:cdi:test:agent:sender".to_string(),
        to_agent_did: "did:cdi:test:agent:recipient".to_string(),
        payload: json!({
            "message": "plain peer text",
        }),
        content_type: Some("application/json".to_string()),
        conversation_id: None,
        reply_to: None,
    };

    let payload = build_openclaw_hook_payload("/hooks/wake", &deliver);
    assert!(payload.get("sessionId").is_none());
    assert_eq!(
        payload.get("message").and_then(|value| value.as_str()),
        payload.get("text").and_then(|value| value.as_str())
    );
    assert_eq!(
        payload.get("text").and_then(|value| value.as_str()),
        Some(
            "Clawdentity peer message from did:cdi:test:agent:sender\n\nplain peer text\n\nRequest ID: req-5"
        )
    );
}

#[test]
fn openclaw_receipt_payload_uses_message_field_for_agent_hooks() {
    let receipt = ReceiptFrame {
        v: 1,
        id: "receipt-1".to_string(),
        ts: "2026-03-20T05:55:00Z".to_string(),
        original_frame_id: "req-6".to_string(),
        to_agent_did: "did:cdi:test:agent:recipient".to_string(),
        status: ReceiptStatus::DeadLettered,
        reason: Some("hook failed".to_string()),
    };

    let payload = build_openclaw_receipt_payload("/hooks/agent", &receipt);
    assert_eq!(
        payload.get("type").and_then(|value| value.as_str()),
        Some("clawdentity:receipt")
    );
    assert_eq!(
        payload.get("status").and_then(|value| value.as_str()),
        Some("dead_lettered")
    );
    assert_eq!(
        payload.get("message").and_then(|value| value.as_str()),
        payload.get("content").and_then(|value| value.as_str())
    );
}

#[test]
fn openclaw_receipt_payload_uses_text_for_wake_hooks() {
    let receipt = ReceiptFrame {
        v: 1,
        id: "receipt-2".to_string(),
        ts: "2026-03-20T05:55:00Z".to_string(),
        original_frame_id: "req-7".to_string(),
        to_agent_did: "did:cdi:test:agent:recipient".to_string(),
        status: ReceiptStatus::ProcessedByOpenclaw,
        reason: None,
    };

    let payload = build_openclaw_receipt_payload("/hooks/wake", &receipt);
    assert_eq!(
        payload.get("status").and_then(|value| value.as_str()),
        Some("processed_by_openclaw")
    );
    assert_eq!(
        payload.get("mode").and_then(|value| value.as_str()),
        Some("now")
    );
    assert_eq!(
        payload.get("message").and_then(|value| value.as_str()),
        payload.get("text").and_then(|value| value.as_str())
    );
}

#[test]
fn pending_retry_dead_letters_at_max_attempt_threshold() {
    assert!(!should_dead_letter_after_failure(0));
    assert!(!should_dead_letter_after_failure(1));
    assert!(should_dead_letter_after_failure(2));
}

fn sample_auth_record(access_token: &str, expires_at: chrono::DateTime<Utc>) -> AgentAuthRecord {
    AgentAuthRecord {
        token_type: "Bearer".to_string(),
        access_token: access_token.to_string(),
        access_expires_at: expires_at.to_rfc3339(),
        refresh_token: "refresh-token".to_string(),
        refresh_expires_at: (expires_at + ChronoDuration::days(7)).to_rfc3339(),
    }
}

#[test]
fn agent_access_refreshes_when_token_missing() {
    let now = Utc::now();
    let record = sample_auth_record("", now + ChronoDuration::minutes(10));
    assert!(agent_access_requires_refresh(&record, now));
}

#[test]
fn agent_access_refreshes_when_token_is_near_expiry() {
    let now = Utc::now();
    let record = sample_auth_record("clw_agt_access", now + ChronoDuration::seconds(30));
    assert!(agent_access_requires_refresh(&record, now));
}

#[test]
fn agent_access_is_reused_when_token_is_still_fresh() {
    let now = Utc::now();
    let record = sample_auth_record("clw_agt_access", now + ChronoDuration::minutes(10));
    assert!(!agent_access_requires_refresh(&record, now));
}
