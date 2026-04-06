use anyhow::anyhow;
use chrono::{Duration as ChronoDuration, Utc};
use clawdentity_core::agent::AgentAuthRecord;
use clawdentity_core::config::get_config_dir;
use clawdentity_core::runtime_openclaw::OpenclawRuntimeConfig;
use clawdentity_core::{
    DeliverFrame, ReceiptFrame, ReceiptStatus, SqliteStore, UpsertPeerInput, get_peer_by_did,
    now_utc_ms, upsert_peer,
};
use serde_json::json;
use std::collections::HashMap;
use std::fs;

use super::runtime_config::{
    agent_access_requires_refresh, load_receipt_post_headers, normalize_proxy_ws_url,
    resolve_openclaw_target_agent_id,
};
use super::{
    SenderProfileHeaders, build_deliver_ack_reason, build_openclaw_delivery_headers,
    build_openclaw_hook_payload, build_openclaw_receipt_payload, forward_deliver_to_openclaw,
    normalize_hook_path, resolve_group_name_for_delivery, resolve_sender_profile_for_delivery,
    should_dead_letter_after_failure,
};
use wiremock::matchers::{body_json, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

mod expected_agent_name;
mod fixtures;
mod inbound_names;
mod openclaw_payload_contract;
mod peer_refresh;
mod provider_runtime;

use fixtures::{
    receipt_fixture_options, setup_receipt_header_fixture,
    setup_receipt_header_fixture_with_registry,
};
#[test]
fn normalizes_hook_path_with_leading_slash() {
    assert_eq!(normalize_hook_path("hooks/agent"), "/hooks/agent");
    assert_eq!(normalize_hook_path("/hooks/agent"), "/hooks/agent");
    assert_eq!(normalize_hook_path("hooks/wake"), "/hooks/wake");
    assert_eq!(normalize_hook_path("/hooks/wake"), "/hooks/wake");
}
#[test]
fn default_openclaw_hook_path_targets_agent_hook() {
    assert_eq!(super::DEFAULT_OPENCLAW_HOOK_PATH, "/hooks/agent");
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
        group_id: None,
        payload: json!({ "message": "hello" }),
        delivery_source: None,
        content_type: Some("application/json".to_string()),
        conversation_id: None,
        reply_to: None,
    };
    let sender_profile = SenderProfileHeaders {
        agent_name: Some("sender-assistant".to_string()),
        display_name: Some("Sender Human".to_string()),
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
            .get("x-clawdentity-display-name")
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
        group_id: None,
        payload: json!({ "message": "hello" }),
        delivery_source: None,
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
    assert!(!header_map.contains_key("x-clawdentity-agent-name"));
    assert!(!header_map.contains_key("x-clawdentity-display-name"));
    assert!(!header_map.contains_key("x-openclaw-token"));
}
#[test]
fn openclaw_hook_payload_uses_message_field() {
    let deliver = DeliverFrame {
        v: 1,
        id: "req-1".to_string(),
        ts: "2026-03-20T05:55:00Z".to_string(),
        from_agent_did: "did:cdi:test:agent:sender".to_string(),
        to_agent_did: "did:cdi:test:agent:recipient".to_string(),
        group_id: None,
        payload: json!({
            "content": "hello from alpha",
            "kind": "relay-test",
        }),
        delivery_source: None,
        content_type: Some("application/json".to_string()),
        conversation_id: Some("conv-1".to_string()),
        reply_to: Some("reply-1".to_string()),
    };

    let payload = build_openclaw_hook_payload("/hooks/agent", &deliver, None, None, None);
    assert_eq!(
        payload.get("message").and_then(|value| value.as_str()),
        Some("did:cdi:test:agent:sender: hello from alpha")
    );
    assert_eq!(
        payload
            .get("metadata")
            .and_then(|value| value.get("sender"))
            .and_then(|value| value.get("id"))
            .and_then(|value| value.as_str()),
        Some("did:cdi:test:agent:sender")
    );
    assert_eq!(
        payload
            .get("metadata")
            .and_then(|value| value.get("conversation"))
            .and_then(|value| value.get("id"))
            .and_then(|value| value.as_str()),
        Some("conv-1")
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
        group_id: None,
        payload: json!({
            "structured": true,
            "count": 2,
        }),
        delivery_source: None,
        content_type: Some("application/json".to_string()),
        conversation_id: None,
        reply_to: None,
    };

    let payload = build_openclaw_hook_payload("/hooks/agent", &deliver, None, None, None);
    assert_eq!(
        payload.get("message").and_then(|value| value.as_str()),
        Some("did:cdi:test:agent:sender: {\"count\":2,\"structured\":true}")
    );
    assert!(payload.get("agentId").is_none());
}

#[test]
fn openclaw_agent_payload_formats_group_message_with_generic_metadata_envelope() {
    let deliver = DeliverFrame {
        v: 1,
        id: "req-group-1".to_string(),
        ts: "2026-03-20T05:55:00Z".to_string(),
        from_agent_did: "did:cdi:test:agent:sender".to_string(),
        to_agent_did: "did:cdi:test:agent:recipient".to_string(),
        group_id: Some("grp_01HF7YAT31JZHSMW1CG6Q6MHB7".to_string()),
        payload: json!({
            "message": "hello group",
        }),
        delivery_source: Some("proxy.events.queue.group_member_joined".to_string()),
        content_type: Some("application/json".to_string()),
        conversation_id: Some("conv-group-1".to_string()),
        reply_to: Some("https://proxy.example/v1/relay/delivery-receipts".to_string()),
    };
    let sender_profile = SenderProfileHeaders {
        agent_name: Some("alpha".to_string()),
        display_name: Some("Ravi".to_string()),
    };

    let payload = build_openclaw_hook_payload(
        "/hooks/agent",
        &deliver,
        Some(&sender_profile),
        Some("research-crew"),
        None,
    );
    assert_eq!(
        payload.get("message").and_then(|value| value.as_str()),
        Some("[research-crew] Ravi: hello group")
    );
    assert_eq!(
        payload
            .get("metadata")
            .and_then(|value| value.get("sender"))
            .and_then(|value| value.get("id"))
            .and_then(|value| value.as_str()),
        Some("did:cdi:test:agent:sender")
    );
    assert_eq!(
        payload
            .get("metadata")
            .and_then(|value| value.get("group"))
            .and_then(|value| value.get("id"))
            .and_then(|value| value.as_str()),
        Some("grp_01HF7YAT31JZHSMW1CG6Q6MHB7")
    );
    assert_eq!(
        payload
            .get("metadata")
            .and_then(|value| value.get("group"))
            .and_then(|value| value.get("name"))
            .and_then(|value| value.as_str()),
        Some("research-crew")
    );
    assert_eq!(
        payload
            .get("metadata")
            .and_then(|value| value.get("trust"))
            .and_then(|value| value.get("verified"))
            .and_then(|value| value.as_bool()),
        Some(true)
    );
    assert_eq!(
        payload
            .get("metadata")
            .and_then(|value| value.get("source"))
            .and_then(|value| value.get("system"))
            .and_then(|value| value.as_str()),
        Some("clawdentity")
    );
}

#[test]
fn openclaw_message_sender_label_fallback_prefers_display_name_then_agent_name_then_did() {
    let deliver = DeliverFrame {
        v: 1,
        id: "req-fallback-1".to_string(),
        ts: "2026-03-20T05:55:00Z".to_string(),
        from_agent_did: "did:cdi:test:agent:sender".to_string(),
        to_agent_did: "did:cdi:test:agent:recipient".to_string(),
        group_id: None,
        payload: json!({
            "message": "hello",
        }),
        delivery_source: None,
        content_type: Some("application/json".to_string()),
        conversation_id: None,
        reply_to: None,
    };

    let with_display = build_openclaw_hook_payload(
        "/hooks/agent",
        &deliver,
        Some(&SenderProfileHeaders {
            agent_name: Some("alpha".to_string()),
            display_name: Some("Ravi".to_string()),
        }),
        None,
        None,
    );
    assert_eq!(
        with_display.get("message").and_then(|value| value.as_str()),
        Some("Ravi: hello")
    );

    let with_agent_name = build_openclaw_hook_payload(
        "/hooks/agent",
        &deliver,
        Some(&SenderProfileHeaders {
            agent_name: Some("alpha".to_string()),
            display_name: None,
        }),
        None,
        None,
    );
    assert_eq!(
        with_agent_name
            .get("message")
            .and_then(|value| value.as_str()),
        Some("alpha: hello")
    );

    let with_did_fallback = build_openclaw_hook_payload("/hooks/agent", &deliver, None, None, None);
    assert_eq!(
        with_did_fallback
            .get("message")
            .and_then(|value| value.as_str()),
        Some("did:cdi:test:agent:sender: hello")
    );
}
#[test]
fn openclaw_agent_hook_payload_includes_agent_id_when_mapping_exists() {
    let deliver = DeliverFrame {
        v: 1,
        id: "req-2b".to_string(),
        ts: "2026-03-20T05:55:00Z".to_string(),
        from_agent_did: "did:cdi:test:agent:sender".to_string(),
        to_agent_did: "did:cdi:test:agent:recipient".to_string(),
        group_id: None,
        payload: json!({
            "message": "hello",
        }),
        delivery_source: None,
        content_type: Some("application/json".to_string()),
        conversation_id: None,
        reply_to: None,
    };

    let payload = build_openclaw_hook_payload("/hooks/agent", &deliver, None, None, Some("alpha"));
    assert_eq!(
        payload.get("agentId").and_then(|value| value.as_str()),
        Some("alpha")
    );
}
#[test]
fn openclaw_agent_hook_payload_omits_agent_id_when_mapping_missing() {
    let deliver = DeliverFrame {
        v: 1,
        id: "req-2c".to_string(),
        ts: "2026-03-20T05:55:00Z".to_string(),
        from_agent_did: "did:cdi:test:agent:sender".to_string(),
        to_agent_did: "did:cdi:test:agent:recipient".to_string(),
        group_id: None,
        payload: json!({
            "message": "hello",
        }),
        delivery_source: None,
        content_type: Some("application/json".to_string()),
        conversation_id: None,
        reply_to: None,
    };

    let payload = build_openclaw_hook_payload("/hooks/agent", &deliver, None, None, None);
    assert!(payload.get("agentId").is_none());
}
#[test]
fn openclaw_wake_payload_preserves_explicit_session_id() {
    let deliver = DeliverFrame {
        v: 1,
        id: "req-3".to_string(),
        ts: "2026-03-20T05:55:00Z".to_string(),
        from_agent_did: "did:cdi:test:agent:sender".to_string(),
        to_agent_did: "did:cdi:test:agent:recipient".to_string(),
        group_id: None,
        payload: json!({
            "content": "hello from alpha",
            "sessionId": "main",
        }),
        delivery_source: None,
        content_type: Some("application/json".to_string()),
        conversation_id: Some("conv-1".to_string()),
        reply_to: Some("reply-1".to_string()),
    };

    let payload = build_openclaw_hook_payload("/hooks/wake", &deliver, None, None, None);
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
    assert_eq!(text, "did:cdi:test:agent:sender: hello from alpha");
}
#[test]
fn openclaw_wake_payload_omits_default_session_override() {
    let deliver = DeliverFrame {
        v: 1,
        id: "req-4".to_string(),
        ts: "2026-03-20T05:55:00Z".to_string(),
        from_agent_did: "did:cdi:test:agent:sender".to_string(),
        to_agent_did: "did:cdi:test:agent:recipient".to_string(),
        group_id: None,
        payload: json!({
            "message": "plain peer text",
        }),
        delivery_source: None,
        content_type: Some("application/json".to_string()),
        conversation_id: None,
        reply_to: None,
    };

    let payload = build_openclaw_hook_payload("/hooks/wake", &deliver, None, None, None);
    assert!(payload.get("sessionId").is_none());
    assert_eq!(
        payload.get("message").and_then(|value| value.as_str()),
        payload.get("text").and_then(|value| value.as_str())
    );
    assert_eq!(
        payload.get("text").and_then(|value| value.as_str()),
        Some("did:cdi:test:agent:sender: plain peer text")
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
        group_id: None,
        payload: json!({
            "message": "plain peer text",
        }),
        delivery_source: None,
        content_type: Some("application/json".to_string()),
        conversation_id: None,
        reply_to: None,
    };

    let payload = build_openclaw_hook_payload("/hooks/wake", &deliver, None, None, None);
    assert!(payload.get("sessionId").is_none());
    assert_eq!(
        payload.get("message").and_then(|value| value.as_str()),
        payload.get("text").and_then(|value| value.as_str())
    );
    assert_eq!(
        payload.get("text").and_then(|value| value.as_str()),
        Some("did:cdi:test:agent:sender: plain peer text")
    );
}
#[test]
fn openclaw_wake_payload_ignores_agent_mapping() {
    let deliver = DeliverFrame {
        v: 1,
        id: "req-5b".to_string(),
        ts: "2026-03-20T05:55:00Z".to_string(),
        from_agent_did: "did:cdi:test:agent:sender".to_string(),
        to_agent_did: "did:cdi:test:agent:recipient".to_string(),
        group_id: None,
        payload: json!({
            "message": "wake test",
        }),
        delivery_source: None,
        content_type: Some("application/json".to_string()),
        conversation_id: None,
        reply_to: None,
    };

    let payload = build_openclaw_hook_payload("/hooks/wake", &deliver, None, None, Some("alpha"));
    assert!(payload.get("agentId").is_none());
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

    let payload = build_openclaw_receipt_payload("/hooks/agent", &receipt, Some("coder"));
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
    assert_eq!(
        payload
            .get("metadata")
            .and_then(|value| value.get("receipt"))
            .and_then(|value| value.get("status"))
            .and_then(|value| value.as_str()),
        Some("dead_lettered")
    );
    assert_eq!(
        payload.get("agentId").and_then(|value| value.as_str()),
        Some("coder")
    );
}
#[test]
fn openclaw_receipt_payload_omits_agent_id_when_mapping_missing() {
    let receipt = ReceiptFrame {
        v: 1,
        id: "receipt-1b".to_string(),
        ts: "2026-03-20T05:55:00Z".to_string(),
        original_frame_id: "req-6b".to_string(),
        to_agent_did: "did:cdi:test:agent:recipient".to_string(),
        status: ReceiptStatus::DeadLettered,
        reason: Some("hook failed".to_string()),
    };

    let payload = build_openclaw_receipt_payload("/hooks/agent", &receipt, None);
    assert!(payload.get("agentId").is_none());
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

    let payload = build_openclaw_receipt_payload("/hooks/wake", &receipt, Some("coder"));
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
    assert_eq!(
        payload
            .get("metadata")
            .and_then(|value| value.get("receipt"))
            .and_then(|value| value.get("status"))
            .and_then(|value| value.as_str()),
        Some("processed_by_openclaw")
    );
    assert!(payload.get("agentId").is_none());
}

#[test]
fn pending_retry_dead_letters_at_max_attempt_threshold() {
    assert!(!should_dead_letter_after_failure(0));
    assert!(!should_dead_letter_after_failure(1));
    assert!(should_dead_letter_after_failure(2));
}
#[test]
fn receipt_post_headers_nonce_uses_random_url_safe_shape() {
    let (options, agent_name) = setup_receipt_header_fixture();
    let headers = load_receipt_post_headers(
        &options,
        &agent_name,
        "https://proxy.example/v1/relay/delivery-receipts",
        br#"{"requestId":"req-1"}"#,
    )
    .expect("receipt headers");
    let nonce = headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("x-claw-nonce"))
        .map(|(_, value)| value)
        .expect("x-claw-nonce header is required");

    assert!(!nonce.starts_with("receipt-"));
    assert!(nonce.len() >= 22);
    assert!(
        nonce
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    );
}
#[test]
fn receipt_post_headers_nonce_changes_between_calls() {
    let (options, agent_name) = setup_receipt_header_fixture();
    let headers_one = load_receipt_post_headers(
        &options,
        &agent_name,
        "https://proxy.example/v1/relay/delivery-receipts",
        br#"{"requestId":"req-1"}"#,
    )
    .expect("first receipt headers");
    let headers_two = load_receipt_post_headers(
        &options,
        &agent_name,
        "https://proxy.example/v1/relay/delivery-receipts",
        br#"{"requestId":"req-1"}"#,
    )
    .expect("second receipt headers");
    let nonce_one = headers_one
        .into_iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("x-claw-nonce"))
        .map(|(_, value)| value)
        .expect("first nonce header");
    let nonce_two = headers_two
        .into_iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("x-claw-nonce"))
        .map(|(_, value)| value)
        .expect("second nonce header");

    assert_ne!(nonce_one, nonce_two);
}
#[test]
fn runtime_config_resolves_mapped_openclaw_target_agent_id() {
    let options = receipt_fixture_options();
    let config_dir = get_config_dir(&options).expect("resolve config dir");
    fs::create_dir_all(&config_dir).expect("create config dir");
    clawdentity_core::save_connector_assignment(
        &config_dir,
        "alpha",
        "http://127.0.0.1:13372",
        Some("beta"),
    )
    .expect("save connector assignment");

    let target_agent_id =
        resolve_openclaw_target_agent_id(&config_dir, "alpha").expect("resolve target agent id");
    assert_eq!(target_agent_id.as_deref(), Some("beta"));
}
#[test]
fn runtime_config_omits_openclaw_target_agent_id_when_assignment_missing() {
    let options = receipt_fixture_options();
    let config_dir = get_config_dir(&options).expect("resolve config dir");
    fs::create_dir_all(&config_dir).expect("create config dir");

    let target_agent_id =
        resolve_openclaw_target_agent_id(&config_dir, "alpha").expect("resolve target agent id");
    assert!(target_agent_id.is_none());
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
