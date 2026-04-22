use super::{
    SenderProfileHeaders, build_deliver_ack_reason, build_delivery_headers,
    build_delivery_receipt_payload, build_delivery_webhook_payload, forward_deliver_to_webhook,
    normalize_hook_path, runtime_config::normalize_proxy_ws_url,
};
use clawdentity_core::{DeliverFrame, ReceiptFrame, ReceiptStatus, runtime_webhook};
use serde_json::json;
use wiremock::matchers::{body_string_contains, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

mod expected_agent_name;

#[test]
fn normalizes_hook_path_with_leading_slash() {
    assert_eq!(normalize_hook_path("hooks/message"), "/hooks/message");
    assert_eq!(normalize_hook_path("/hooks/message"), "/hooks/message");
}

#[test]
fn normalizes_proxy_http_url_to_ws_connect_route() {
    let resolved = normalize_proxy_ws_url("http://127.0.0.1:13371").expect("proxy ws url");
    assert_eq!(resolved, "ws://127.0.0.1:13371/v1/relay/connect");
}

#[test]
fn delivery_headers_include_profile_and_custom_headers() {
    let deliver = DeliverFrame {
        v: 1,
        id: "req-headers-1".to_string(),
        ts: "2026-03-20T05:55:00Z".to_string(),
        from_agent_did: "did:cdi:test:agent:sender".to_string(),
        to_agent_did: "did:cdi:test:agent:recipient".to_string(),
        group_id: Some("grp_01TEST".to_string()),
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
    let headers = build_delivery_headers(
        &deliver,
        Some(&sender_profile),
        &[("authorization".to_string(), "Bearer test".to_string())],
    );
    let as_map = headers
        .into_iter()
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(
        as_map.get("content-type").map(std::string::String::as_str),
        Some("application/vnd.clawdentity.delivery+json")
    );
    assert_eq!(
        as_map.get("authorization").map(std::string::String::as_str),
        Some("Bearer test")
    );
    assert_eq!(
        as_map
            .get("x-clawdentity-agent-name")
            .map(std::string::String::as_str),
        Some("sender-assistant")
    );
}

#[test]
fn delivery_payload_matches_generic_contract() {
    let deliver = DeliverFrame {
        v: 1,
        id: "req-1".to_string(),
        ts: "2026-03-20T05:55:00Z".to_string(),
        from_agent_did: "did:cdi:test:agent:sender".to_string(),
        to_agent_did: "did:cdi:test:agent:recipient".to_string(),
        group_id: Some("grp_01TEST".to_string()),
        payload: json!({ "message": "hello from alpha" }),
        delivery_source: Some("relay".to_string()),
        content_type: Some("application/json".to_string()),
        conversation_id: Some("conv-1".to_string()),
        reply_to: Some("reply-1".to_string()),
    };
    let payload = build_delivery_webhook_payload(&deliver, None, Some("alpha-group"));
    assert_eq!(
        payload.get("type").and_then(|value| value.as_str()),
        Some("clawdentity.delivery.v1")
    );
    assert_eq!(
        payload.get("requestId").and_then(|value| value.as_str()),
        Some("req-1")
    );
}

#[test]
fn delivery_payload_omits_optional_fields_when_absent() {
    let deliver = DeliverFrame {
        v: 1,
        id: "req-optional-1".to_string(),
        ts: "2026-03-20T05:55:00Z".to_string(),
        from_agent_did: "did:cdi:test:agent:sender".to_string(),
        to_agent_did: "did:cdi:test:agent:recipient".to_string(),
        group_id: None,
        payload: json!({ "message": "hello from alpha" }),
        delivery_source: None,
        content_type: None,
        conversation_id: None,
        reply_to: None,
    };
    let payload = build_delivery_webhook_payload(&deliver, None, None);
    assert!(payload.get("conversationId").is_none());
    assert!(payload.get("groupId").is_none());
    assert!(payload.get("senderAgentName").is_none());
    assert!(payload.get("senderDisplayName").is_none());
    assert_eq!(
        payload
            .get("relayMetadata")
            .and_then(|value| value.get("deliverySource")),
        None
    );
    assert_eq!(
        payload
            .get("relayMetadata")
            .and_then(|value| value.get("contentType")),
        None
    );
    assert_eq!(
        payload
            .get("relayMetadata")
            .and_then(|value| value.get("replyTo")),
        None
    );
    assert_eq!(
        payload
            .get("relayMetadata")
            .and_then(|value| value.get("groupName")),
        None
    );
}

#[test]
fn receipt_payload_uses_delivered_to_webhook_status() {
    let receipt = ReceiptFrame {
        v: 1,
        id: "01JTEST".to_string(),
        ts: "2026-03-20T05:55:00Z".to_string(),
        original_frame_id: "01JREQUEST".to_string(),
        to_agent_did: "did:cdi:test:agent:recipient".to_string(),
        status: ReceiptStatus::DeliveredToWebhook,
        reason: None,
    };
    let payload = build_delivery_receipt_payload(&receipt);
    assert_eq!(
        payload.get("status").and_then(|value| value.as_str()),
        Some("delivered_to_webhook")
    );
    assert!(payload.get("reason").is_none());
}

#[tokio::test]
async fn forwards_delivery_to_webhook() {
    let mock_server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/hooks/relay"))
        .and(body_string_contains("\"type\":\"clawdentity.delivery.v1\""))
        .and(body_string_contains("\"requestId\":\"req-forward-1\""))
        .respond_with(ResponseTemplate::new(200))
        .mount(&mock_server)
        .await;

    let http_client = reqwest::Client::builder().build().expect("http client");
    let runtime = runtime_webhook::DeliveryWebhookRuntimeConfig {
        webhook_url: format!("{}/hooks/relay", mock_server.uri()),
        health_url: None,
        webhook_headers: vec![],
    };
    let deliver = DeliverFrame {
        v: 1,
        id: "req-forward-1".to_string(),
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
    forward_deliver_to_webhook(
        &http_client,
        &runtime.webhook_url,
        &runtime,
        &deliver,
        None,
        None,
    )
    .await
    .expect("forward to webhook");
}

#[test]
fn deliver_ack_reason_contract_is_unchanged() {
    let delivery_error = anyhow::anyhow!("delivery webhook returned HTTP 500");
    let persistence_error = anyhow::anyhow!("sqlite unavailable");
    let reason = build_deliver_ack_reason(Some(&delivery_error), Some(&persistence_error));
    assert_eq!(
        reason.as_deref(),
        Some(
            "delivery webhook returned HTTP 500; failed to persist inbound delivery result: sqlite unavailable"
        )
    );
}
