use std::collections::HashMap;

use tempfile::TempDir;
use wiremock::matchers::{body_string, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use crate::provider::{
    InboundMessage, InstallOptions, PlatformProvider, ProviderDoctorCheckStatus,
    ProviderDoctorOptions, ProviderRelayTestOptions,
};

use super::{HERMES_CONFIG_FILE, HERMES_DIR_NAME, HermesProvider};

fn yaml_key(key: &str) -> serde_yaml::Value {
    serde_yaml::Value::String(key.to_string())
}

#[test]
fn detection_checks_home_and_path() {
    let home = TempDir::new().expect("temp home");
    let hermes_dir = home.path().join(HERMES_DIR_NAME);
    std::fs::create_dir_all(&hermes_dir).expect("hermes dir");
    std::fs::write(hermes_dir.join(HERMES_CONFIG_FILE), "platforms: {}\n").expect("config");

    let bin_dir = TempDir::new().expect("temp bin");
    std::fs::write(bin_dir.path().join("hermes"), "#!/bin/sh\n").expect("binary");

    let provider = HermesProvider::with_test_context(
        home.path().to_path_buf(),
        vec![bin_dir.path().to_path_buf()],
    );
    let detection = provider.detect();

    assert!(detection.detected);
    assert!(detection.confidence > 0.8);
    assert!(
        detection
            .evidence
            .iter()
            .any(|entry| entry.contains("hermes binary in PATH"))
    );
}

#[test]
fn config_path_defaults_to_hermes_yaml() {
    let home = TempDir::new().expect("temp home");
    let provider = HermesProvider::with_test_context(home.path().to_path_buf(), Vec::new());

    let config_path = provider.config_path().expect("config path");
    assert_eq!(
        config_path,
        home.path().join(HERMES_DIR_NAME).join(HERMES_CONFIG_FILE)
    );
}

#[test]
fn format_inbound_includes_sender_message_and_session_key() {
    let provider = HermesProvider::default();
    let mut metadata = HashMap::new();
    metadata.insert("conversationId".to_string(), "thread-1".to_string());

    let request = provider.format_inbound(&InboundMessage {
        sender_did: "did:cdi:test:agent:sender".to_string(),
        recipient_did: "did:cdi:test:agent:receiver".to_string(),
        content: "hello".to_string(),
        request_id: Some("req-1".to_string()),
        metadata,
    });

    assert_eq!(
        request
            .body
            .get("sender_did")
            .and_then(|value| value.as_str()),
        Some("did:cdi:test:agent:sender")
    );
    assert_eq!(
        request.body.get("message").and_then(|value| value.as_str()),
        Some("hello")
    );
    assert_eq!(
        request
            .body
            .get("session_key")
            .and_then(|value| value.as_str()),
        Some("peer:did:cdi:test:agent:sender:thread-1")
    );
    assert_eq!(
        request
            .headers
            .get("x-request-id")
            .map(std::string::String::as_str),
        Some("req-1")
    );
    assert_eq!(
        request
            .headers
            .get("x-webhook-session-key")
            .map(std::string::String::as_str),
        Some("peer:did:cdi:test:agent:sender:thread-1")
    );
}

#[test]
fn install_upserts_clawdentity_route_into_yaml() {
    let home = TempDir::new().expect("temp home");
    let config_dir = home.path().join(HERMES_DIR_NAME);
    std::fs::create_dir_all(&config_dir).expect("config dir");
    let config_path = config_dir.join(HERMES_CONFIG_FILE);
    std::fs::write(
        &config_path,
        r#"
platforms:
  webhook:
    enabled: false
    extra:
      routes:
        github:
          secret: existing-secret
"#,
    )
    .expect("seed config");

    let provider = HermesProvider::with_test_context(home.path().to_path_buf(), Vec::new());
    provider
        .install(&InstallOptions {
            home_dir: Some(home.path().to_path_buf()),
            webhook_port: Some(8644),
            webhook_host: Some("127.0.0.1".to_string()),
            webhook_token: Some("fixed-secret".to_string()),
            connector_url: None,
        })
        .expect("install");

    let updated = std::fs::read_to_string(&config_path).expect("read config");
    let parsed: serde_yaml::Value = serde_yaml::from_str(&updated).expect("parse yaml");
    let routes = parsed
        .as_mapping()
        .and_then(|root| root.get(yaml_key("platforms")))
        .and_then(serde_yaml::Value::as_mapping)
        .and_then(|platforms| platforms.get(yaml_key("webhook")))
        .and_then(serde_yaml::Value::as_mapping)
        .and_then(|webhook| webhook.get(yaml_key("extra")))
        .and_then(serde_yaml::Value::as_mapping)
        .and_then(|extra| extra.get(yaml_key("routes")))
        .and_then(serde_yaml::Value::as_mapping)
        .expect("routes");

    assert!(routes.contains_key(yaml_key("github")));
    assert!(routes.contains_key(yaml_key("clawdentity")));
}

#[test]
fn doctor_reports_missing_route() {
    let home = TempDir::new().expect("temp home");
    let config_dir = home.path().join(HERMES_DIR_NAME);
    std::fs::create_dir_all(&config_dir).expect("config dir");
    std::fs::write(
        config_dir.join(HERMES_CONFIG_FILE),
        r#"
platforms:
  webhook:
    enabled: true
    extra:
      host: 127.0.0.1
      port: 8644
"#,
    )
    .expect("seed config");

    let provider = HermesProvider::with_test_context(home.path().to_path_buf(), Vec::new());
    let result = provider
        .doctor(&ProviderDoctorOptions {
            home_dir: Some(home.path().to_path_buf()),
            include_connector_runtime_check: false,
            ..ProviderDoctorOptions::default()
        })
        .expect("doctor result");
    let route_check = result
        .checks
        .iter()
        .find(|check| check.id == "config.route")
        .expect("config.route check");

    assert_eq!(route_check.status, ProviderDoctorCheckStatus::Fail);
}

#[tokio::test(flavor = "multi_thread")]
async fn relay_test_signs_with_expected_hmac_headers() {
    let server = MockServer::start().await;
    let secret = "relay-secret";
    let request_id = "relay-test-req";
    let sender = "did:cdi:test:agent:peer";
    let expected_body = serde_json::json!({
        "sender_did": sender,
        "message": "hello",
        "request_id": request_id,
        "metadata": {
            "peerAlias": sender,
            "source": "clawdentity-provider-relay-test"
        }
    });
    let expected_body_string = serde_json::to_string(&expected_body).expect("body");
    let expected_signature =
        HermesProvider::hmac_sha256_hex(secret, expected_body_string.as_bytes());

    Mock::given(method("POST"))
        .and(path("/webhooks/clawdentity"))
        .and(header("x-request-id", request_id))
        .and(header(
            "x-webhook-session-key",
            "peer:did:cdi:test:agent:peer",
        ))
        .and(header("x-webhook-signature", expected_signature))
        .and(body_string(expected_body_string))
        .respond_with(ResponseTemplate::new(202))
        .mount(&server)
        .await;

    let temp_home = TempDir::new().expect("temp home");
    let provider = HermesProvider::with_test_context(temp_home.path().to_path_buf(), Vec::new());
    let options = ProviderRelayTestOptions {
        home_dir: Some(temp_home.path().to_path_buf()),
        peer_alias: Some(sender.to_string()),
        connector_base_url: Some(server.uri()),
        webhook_token: Some(secret.to_string()),
        message: Some("hello".to_string()),
        session_id: Some(request_id.to_string()),
        skip_preflight: true,
        ..ProviderRelayTestOptions::default()
    };
    let result = tokio::task::spawn_blocking(move || provider.relay_test(&options))
        .await
        .expect("spawn blocking")
        .expect("relay test");

    assert_eq!(
        result.status,
        crate::provider::ProviderRelayTestStatus::Success
    );
    assert_eq!(result.http_status, Some(202));
}
