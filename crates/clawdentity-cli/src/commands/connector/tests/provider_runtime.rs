use clawdentity_core::{ProviderRelayRuntimeConfig, get_config_dir, now_iso};
use serde_json::json;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use super::super::runtime_config::resolve_runtime_config;
use super::super::{
    InboundDeliveryTarget, ProviderInboundRuntime, SenderProfileHeaders, StartConnectorInput,
    forward_deliver_to_provider,
};
use super::fixtures::{
    hmac_sha256_hex, receipt_fixture_options, write_receipt_fixture_agent_files_with_framework,
    write_receipt_fixture_config,
};

fn request_header_value<'a>(request: &'a wiremock::Request, name: &str) -> Option<&'a str> {
    request
        .headers
        .get(name)
        .and_then(|value| value.to_str().ok())
}

#[tokio::test]
async fn forward_delivery_posts_signed_group_payload_for_hermes() {
    let server = MockServer::start().await;
    let secret = "relay-secret";
    let deliver = clawdentity_core::DeliverFrame {
        v: 1,
        id: "req-hermes-1".to_string(),
        ts: "2026-03-20T05:55:00Z".to_string(),
        from_agent_did: "did:cdi:test:agent:sender".to_string(),
        to_agent_did: "did:cdi:test:agent:recipient".to_string(),
        group_id: Some("grp_01HF7YAT31JZHSMW1CG6Q6MHB7".to_string()),
        payload: json!({ "message": "hello group" }),
        delivery_source: None,
        content_type: Some("application/json".to_string()),
        conversation_id: Some("conv-group-1".to_string()),
        reply_to: None,
    };
    let sender_profile = SenderProfileHeaders {
        agent_name: Some("alpha-local".to_string()),
        display_name: Some("Alpha".to_string()),
    };

    Mock::given(method("POST"))
        .and(path("/webhooks/clawdentity"))
        .respond_with(ResponseTemplate::new(202))
        .expect(1)
        .mount(&server)
        .await;

    let runtime = ProviderInboundRuntime {
        provider: "hermes".to_string(),
        display_name: "Hermes".to_string(),
        webhook_endpoint: format!("{}/webhooks/clawdentity", server.uri()),
        webhook_token: Some(secret.to_string()),
    };
    let client = reqwest::Client::new();

    forward_deliver_to_provider(
        &client,
        &runtime,
        &deliver,
        Some(&sender_profile),
        Some("Project Room"),
    )
    .await
    .expect("forward delivery should succeed");

    let requests = server.received_requests().await.expect("received requests");
    let request = requests.first().expect("first request");
    let body: serde_json::Value = serde_json::from_slice(&request.body).expect("json body");

    assert_eq!(
        request_header_value(request, "x-request-id"),
        Some("req-hermes-1")
    );
    assert_eq!(
        request_header_value(request, "x-webhook-session-key"),
        Some("group:grp_01HF7YAT31JZHSMW1CG6Q6MHB7:conv-group-1")
    );
    assert_eq!(
        request_header_value(request, "x-webhook-signature"),
        Some(hmac_sha256_hex(secret, &request.body).as_str())
    );
    assert_eq!(
        body.get("sender_did").and_then(|value| value.as_str()),
        Some("did:cdi:test:agent:sender")
    );
    assert_eq!(
        body.get("recipient_did").and_then(|value| value.as_str()),
        Some("did:cdi:test:agent:recipient")
    );
    assert_eq!(
        body.get("message").and_then(|value| value.as_str()),
        Some("hello group")
    );
    assert_eq!(
        body.get("content").and_then(|value| value.as_str()),
        Some("hello group")
    );
    assert_eq!(
        body.get("request_id").and_then(|value| value.as_str()),
        Some("req-hermes-1")
    );
    assert_eq!(
        body.get("session_key").and_then(|value| value.as_str()),
        Some("group:grp_01HF7YAT31JZHSMW1CG6Q6MHB7:conv-group-1")
    );
    assert_eq!(
        body.get("metadata")
            .and_then(|value| value.get("groupId"))
            .and_then(|value| value.as_str()),
        Some("grp_01HF7YAT31JZHSMW1CG6Q6MHB7")
    );
    assert_eq!(
        body.get("metadata")
            .and_then(|value| value.get("groupName"))
            .and_then(|value| value.as_str()),
        Some("Project Room")
    );
    assert_eq!(
        body.get("metadata")
            .and_then(|value| value.get("conversationId"))
            .and_then(|value| value.as_str()),
        Some("conv-group-1")
    );
    assert_eq!(
        body.get("metadata")
            .and_then(|value| value.get("senderAgentName"))
            .and_then(|value| value.as_str()),
        Some("alpha-local")
    );
    assert_eq!(
        body.get("metadata")
            .and_then(|value| value.get("senderDisplayName"))
            .and_then(|value| value.as_str()),
        Some("Alpha")
    );
}

#[tokio::test]
async fn runtime_config_uses_provider_target_for_hermes_agent() {
    let options = receipt_fixture_options();
    write_receipt_fixture_config(&options, "https://registry.example");
    write_receipt_fixture_agent_files_with_framework(&options, "alpha", "hermes");
    let config_dir = get_config_dir(&options).expect("resolve config dir");
    clawdentity_core::write_provider_agent_marker(&config_dir, "hermes", "alpha")
        .expect("write provider marker");
    clawdentity_core::save_provider_runtime_config(
        &config_dir,
        "hermes",
        ProviderRelayRuntimeConfig {
            webhook_endpoint: "http://127.0.0.1:8644/webhooks/clawdentity".to_string(),
            connector_base_url: Some("http://127.0.0.1:19400".to_string()),
            webhook_token: Some("relay-secret".to_string()),
            platform_base_url: None,
            relay_transform_peers_path: None,
            updated_at: now_iso(),
        },
    )
    .expect("save provider runtime");

    let runtime = resolve_runtime_config(
        &options,
        StartConnectorInput {
            agent_name: "alpha".to_string(),
            proxy_ws_url: None,
            openclaw_base_url: None,
            openclaw_hook_path: None,
            openclaw_hook_token: None,
            port: 19400,
            bind: "127.0.0.1".parse().expect("bind"),
        },
    )
    .await
    .expect("resolve runtime");

    match runtime.inbound_target {
        InboundDeliveryTarget::Provider(runtime) => {
            assert_eq!(runtime.provider, "hermes");
            assert_eq!(runtime.display_name, "Hermes");
            assert_eq!(
                runtime.webhook_endpoint,
                "http://127.0.0.1:8644/webhooks/clawdentity"
            );
            assert_eq!(runtime.webhook_token.as_deref(), Some("relay-secret"));
        }
        InboundDeliveryTarget::Openclaw(_) => panic!("expected provider target"),
    }
}

#[tokio::test]
async fn runtime_config_rejects_openclaw_overrides_for_hermes_agent() {
    let options = receipt_fixture_options();
    write_receipt_fixture_config(&options, "https://registry.example");
    write_receipt_fixture_agent_files_with_framework(&options, "alpha", "hermes");
    let config_dir = get_config_dir(&options).expect("resolve config dir");
    clawdentity_core::write_provider_agent_marker(&config_dir, "hermes", "alpha")
        .expect("write provider marker");
    clawdentity_core::save_provider_runtime_config(
        &config_dir,
        "hermes",
        ProviderRelayRuntimeConfig {
            webhook_endpoint: "http://127.0.0.1:8644/webhooks/clawdentity".to_string(),
            connector_base_url: Some("http://127.0.0.1:19400".to_string()),
            webhook_token: Some("relay-secret".to_string()),
            platform_base_url: None,
            relay_transform_peers_path: None,
            updated_at: now_iso(),
        },
    )
    .expect("save provider runtime");

    let error = resolve_runtime_config(
        &options,
        StartConnectorInput {
            agent_name: "alpha".to_string(),
            proxy_ws_url: None,
            openclaw_base_url: Some("http://127.0.0.1:18789".to_string()),
            openclaw_hook_path: None,
            openclaw_hook_token: None,
            port: 19400,
            bind: "127.0.0.1".parse().expect("bind"),
        },
    )
    .await
    .expect_err("hermes runtime should reject openclaw overrides");

    assert!(
        error
            .to_string()
            .contains("OpenClaw-only connector overrides are not valid here")
    );
}
