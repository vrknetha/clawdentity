use anyhow::anyhow;
use chrono::{Duration as ChronoDuration, Utc};
use clawdentity_core::agent::AgentAuthRecord;
use clawdentity_core::config::{CliConfig, ConfigPathOptions, get_config_dir, write_config};
use clawdentity_core::constants::{AGENTS_DIR, AIT_FILE_NAME, SECRET_KEY_FILE_NAME};
use clawdentity_core::runtime_openclaw::OpenclawRuntimeConfig;
use clawdentity_core::{DeliverFrame, ReceiptFrame, ReceiptStatus};
use serde_json::json;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use super::runtime_config::{
    agent_access_requires_refresh, load_receipt_post_headers, normalize_proxy_ws_url,
    resolve_openclaw_target_agent_id,
};
use super::{
    SenderProfileHeaders, build_deliver_ack_reason, build_openclaw_delivery_headers,
    build_openclaw_hook_payload, build_openclaw_receipt_payload, forward_deliver_to_openclaw,
    normalize_hook_path, should_dead_letter_after_failure,
};
use wiremock::matchers::{body_json, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

mod expected_agent_name;

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
        delivery_source: None,
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
    assert!(!header_map.contains_key("x-clawdentity-human-name"));
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
        payload: json!({
            "content": "hello from alpha",
            "kind": "relay-test",
        }),
        delivery_source: None,
        content_type: Some("application/json".to_string()),
        conversation_id: Some("conv-1".to_string()),
        reply_to: Some("reply-1".to_string()),
    };

    let payload = build_openclaw_hook_payload("/hooks/agent", &deliver, None);
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
        delivery_source: None,
        content_type: Some("application/json".to_string()),
        conversation_id: None,
        reply_to: None,
    };

    let payload = build_openclaw_hook_payload("/hooks/agent", &deliver, None);
    assert_eq!(
        payload.get("message").and_then(|value| value.as_str()),
        Some("{\"count\":2,\"structured\":true}")
    );
    assert!(payload.get("agentId").is_none());
}

#[test]
fn openclaw_agent_hook_payload_includes_agent_id_when_mapping_exists() {
    let deliver = DeliverFrame {
        v: 1,
        id: "req-2b".to_string(),
        ts: "2026-03-20T05:55:00Z".to_string(),
        from_agent_did: "did:cdi:test:agent:sender".to_string(),
        to_agent_did: "did:cdi:test:agent:recipient".to_string(),
        payload: json!({
            "message": "hello",
        }),
        delivery_source: None,
        content_type: Some("application/json".to_string()),
        conversation_id: None,
        reply_to: None,
    };

    let payload = build_openclaw_hook_payload("/hooks/agent", &deliver, Some("alpha"));
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
        payload: json!({
            "message": "hello",
        }),
        delivery_source: None,
        content_type: Some("application/json".to_string()),
        conversation_id: None,
        reply_to: None,
    };

    let payload = build_openclaw_hook_payload("/hooks/agent", &deliver, None);
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
        payload: json!({
            "content": "hello from alpha",
            "sessionId": "main",
        }),
        delivery_source: None,
        content_type: Some("application/json".to_string()),
        conversation_id: Some("conv-1".to_string()),
        reply_to: Some("reply-1".to_string()),
    };

    let payload = build_openclaw_hook_payload("/hooks/wake", &deliver, None);
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
        delivery_source: None,
        content_type: Some("application/json".to_string()),
        conversation_id: None,
        reply_to: None,
    };

    let payload = build_openclaw_hook_payload("/hooks/wake", &deliver, None);
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
        delivery_source: None,
        content_type: Some("application/json".to_string()),
        conversation_id: None,
        reply_to: None,
    };

    let payload = build_openclaw_hook_payload("/hooks/wake", &deliver, None);
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
fn openclaw_wake_payload_ignores_agent_mapping() {
    let deliver = DeliverFrame {
        v: 1,
        id: "req-5b".to_string(),
        ts: "2026-03-20T05:55:00Z".to_string(),
        from_agent_did: "did:cdi:test:agent:sender".to_string(),
        to_agent_did: "did:cdi:test:agent:recipient".to_string(),
        payload: json!({
            "message": "wake test",
        }),
        delivery_source: None,
        content_type: Some("application/json".to_string()),
        conversation_id: None,
        reply_to: None,
    };

    let payload = build_openclaw_hook_payload("/hooks/wake", &deliver, Some("alpha"));
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

#[tokio::test]
async fn forward_delivery_posts_agent_id_for_agent_hook_path() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/hooks/agent"))
        .and(body_json(json!({
            "message": "hello over relay",
            "content": "hello over relay",
            "senderDid": "did:cdi:test:agent:sender",
            "recipientDid": "did:cdi:test:agent:recipient",
            "requestId": "req-e2e-1",
            "agentId": "coder",
            "metadata": {
                "conversationId": serde_json::Value::Null,
                "replyTo": serde_json::Value::Null,
                "payload": {
                    "message": "hello over relay"
                }
            }
        })))
        .respond_with(ResponseTemplate::new(200))
        .expect(1)
        .mount(&server)
        .await;

    let runtime = OpenclawRuntimeConfig {
        base_url: server.uri(),
        hook_path: "/hooks/agent".to_string(),
        hook_token: None,
        target_agent_id: Some("coder".to_string()),
    };
    let deliver = DeliverFrame {
        v: 1,
        id: "req-e2e-1".to_string(),
        ts: "2026-03-20T05:55:00Z".to_string(),
        from_agent_did: "did:cdi:test:agent:sender".to_string(),
        to_agent_did: "did:cdi:test:agent:recipient".to_string(),
        payload: json!({ "message": "hello over relay" }),
        delivery_source: None,
        content_type: Some("application/json".to_string()),
        conversation_id: None,
        reply_to: None,
    };
    let hook_url = runtime.hook_url().expect("hook url");
    let client = reqwest::Client::new();

    forward_deliver_to_openclaw(&client, &hook_url, &runtime, &deliver, None)
        .await
        .expect("forward delivery should succeed");
}

#[test]
fn pending_retry_dead_letters_at_max_attempt_threshold() {
    assert!(!should_dead_letter_after_failure(0));
    assert!(!should_dead_letter_after_failure(1));
    assert!(should_dead_letter_after_failure(2));
}

fn encode_base64url(input: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

    let mut output = String::with_capacity((input.len() * 4).div_ceil(3));
    let mut index = 0usize;
    while index + 3 <= input.len() {
        let block = ((input[index] as u32) << 16)
            | ((input[index + 1] as u32) << 8)
            | (input[index + 2] as u32);
        output.push(ALPHABET[((block >> 18) & 0x3f) as usize] as char);
        output.push(ALPHABET[((block >> 12) & 0x3f) as usize] as char);
        output.push(ALPHABET[((block >> 6) & 0x3f) as usize] as char);
        output.push(ALPHABET[(block & 0x3f) as usize] as char);
        index += 3;
    }

    match input.len() - index {
        1 => {
            let block = (input[index] as u32) << 16;
            output.push(ALPHABET[((block >> 18) & 0x3f) as usize] as char);
            output.push(ALPHABET[((block >> 12) & 0x3f) as usize] as char);
        }
        2 => {
            let block = ((input[index] as u32) << 16) | ((input[index + 1] as u32) << 8);
            output.push(ALPHABET[((block >> 18) & 0x3f) as usize] as char);
            output.push(ALPHABET[((block >> 12) & 0x3f) as usize] as char);
            output.push(ALPHABET[((block >> 6) & 0x3f) as usize] as char);
        }
        _ => {}
    }

    output
}

fn fixture_ait() -> String {
    let header = r#"{"alg":"EdDSA","kid":"key-1","typ":"JWT"}"#;
    let payload = r#"{"sub":"did:cdi:test:agent:alpha","ownerDid":"did:cdi:test:human:owner","cnf":{"jwk":{"x":"public-key-x"}},"exp":4102444800,"framework":"openclaw"}"#;
    format!(
        "{}.{}.sig",
        encode_base64url(header.as_bytes()),
        encode_base64url(payload.as_bytes())
    )
}

static RECEIPT_FIXTURE_COUNTER: AtomicU64 = AtomicU64::new(1);

fn setup_receipt_header_fixture() -> (ConfigPathOptions, String) {
    let options = receipt_fixture_options();
    write_receipt_fixture_config(&options);

    let agent_name = "alpha".to_string();
    write_receipt_fixture_agent_files(&options, &agent_name);
    (options, agent_name)
}

fn receipt_fixture_options() -> ConfigPathOptions {
    let fixture_id = RECEIPT_FIXTURE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "clawdentity-connector-tests-{}-{}-{fixture_id}",
        std::process::id(),
        Utc::now().timestamp_nanos_opt().unwrap_or(0)
    ));
    fs::create_dir_all(&root).expect("create test root");

    ConfigPathOptions {
        home_dir: Some(root),
        registry_url_hint: None,
    }
}

fn write_receipt_fixture_config(options: &ConfigPathOptions) {
    write_config(
        &CliConfig {
            registry_url: "https://registry.example".to_string(),
            proxy_url: Some("https://proxy.example".to_string()),
            api_key: None,
            human_name: Some("Tester".to_string()),
        },
        options,
    )
    .expect("write config");
}

fn write_receipt_fixture_agent_files(options: &ConfigPathOptions, agent_name: &str) {
    let config_dir = get_config_dir(options).expect("resolve config dir");
    let agent_dir = config_dir.join(AGENTS_DIR).join(agent_name);
    fs::create_dir_all(&agent_dir).expect("create agent dir");

    write_receipt_fixture_ait(&agent_dir);
    write_receipt_fixture_secret_key(&agent_dir);
    write_receipt_fixture_auth(&agent_dir);
}

fn write_receipt_fixture_ait(agent_dir: &Path) {
    fs::write(
        agent_dir.join(AIT_FILE_NAME),
        format!("{}\n", fixture_ait()),
    )
    .expect("write ait");
}

fn write_receipt_fixture_secret_key(agent_dir: &Path) {
    fs::write(
        agent_dir.join(SECRET_KEY_FILE_NAME),
        format!("{}\n", encode_base64url(&[7_u8; 32])),
    )
    .expect("write secret key");
}

fn write_receipt_fixture_auth(agent_dir: &Path) {
    fs::write(
        agent_dir.join("registry-auth.json"),
        receipt_fixture_registry_auth_json(),
    )
    .expect("write registry auth");
}

fn receipt_fixture_registry_auth_json() -> &'static str {
    r#"{
  "tokenType": "Bearer",
  "accessToken": "clw_agt_access",
  "accessExpiresAt": "2099-01-01T00:00:00Z",
  "refreshToken": "clw_agt_refresh",
  "refreshExpiresAt": "2099-01-08T00:00:00Z"
}
"#
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
