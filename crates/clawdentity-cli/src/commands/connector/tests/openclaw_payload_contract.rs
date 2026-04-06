use clawdentity_core::runtime_openclaw::OpenclawRuntimeConfig;
use clawdentity_core::DeliverFrame;
use serde_json::json;
use wiremock::matchers::{body_json, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use super::forward_deliver_to_openclaw;

#[tokio::test]
async fn forward_delivery_posts_agent_id_for_agent_hook_path() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/hooks/agent"))
        .and(body_json(json!({
            "message": "did:cdi:test:agent:sender: hello over relay",
            "agentId": "coder",
            "metadata": {
                "sender": {
                    "id": "did:cdi:test:agent:sender",
                    "displayName": serde_json::Value::Null,
                    "agentName": serde_json::Value::Null
                },
                "group": serde_json::Value::Null,
                "conversation": {
                    "id": serde_json::Value::Null
                },
                "reply": {
                    "id": "req-e2e-1",
                    "to": serde_json::Value::Null
                },
                "trust": {
                    "verified": true
                },
                "source": {
                    "system": "clawdentity",
                    "deliverySource": serde_json::Value::Null
                },
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
        group_id: None,
        payload: json!({ "message": "hello over relay" }),
        delivery_source: None,
        content_type: Some("application/json".to_string()),
        conversation_id: None,
        reply_to: None,
    };
    let hook_url = runtime.hook_url().expect("hook url");
    let client = reqwest::Client::new();

    forward_deliver_to_openclaw(&client, &hook_url, &runtime, &deliver, None, None)
        .await
        .expect("forward delivery should succeed");
}
