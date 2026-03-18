use std::collections::HashMap;
use std::fs;

use serde_json::Value;
use tempfile::TempDir;

use crate::{
    config::{ConfigPathOptions, get_config_dir},
    provider::{
        InboundMessage, InstallOptions, PlatformProvider, ProviderDoctorOptions,
        ProviderSetupOptions,
    },
};

use super::{
    OPENCLAW_CONFIG_FILE_NAME, OpenclawProvider,
    assets::{transform_peers_path, transform_runtime_path},
    load_connector_assignments, resolve_openclaw_dir,
    test_support::{install_mock_openclaw_cli, write_openclaw_profile},
};

#[test]
fn detection_checks_home_and_path_evidence() {
    let home = TempDir::new().expect("temp home");
    write_openclaw_profile(home.path(), "{}\n");
    let bin_dir = install_mock_openclaw_cli();

    let provider = OpenclawProvider::with_test_context(
        home.path().to_path_buf(),
        vec![bin_dir.path().to_path_buf()],
    );
    let detection = provider.detect();

    assert!(detection.detected);
    assert!(detection.confidence > 0.9);
    assert!(
        detection
            .evidence
            .iter()
            .any(|entry| entry.contains("openclaw binary in PATH"))
    );
}

#[test]
fn format_inbound_uses_openclaw_webhook_shape() {
    let provider = OpenclawProvider::default();
    let mut metadata = HashMap::new();
    metadata.insert("thread".to_string(), "relay".to_string());

    let request = provider.format_inbound(&InboundMessage {
        sender_did: "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXTB".to_string(),
        recipient_did: "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXTC"
            .to_string(),
        content: "hello".to_string(),
        request_id: Some("req-123".to_string()),
        metadata,
    });

    assert_eq!(
        request
            .headers
            .get("x-webhook-sender-id")
            .map(String::as_str),
        Some("did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXTB")
    );
    assert_eq!(
        request.body.get("content").and_then(|value| value.as_str()),
        Some("hello")
    );
    assert_eq!(
        request.body.get("path").and_then(|value| value.as_str()),
        Some("/hooks/agent")
    );
}

#[test]
fn config_path_points_to_openclaw_json() {
    let home = TempDir::new().expect("temp home");
    let provider = OpenclawProvider::with_test_context(home.path().to_path_buf(), Vec::new());

    assert_eq!(
        provider.config_path(),
        Some(
            resolve_openclaw_dir(Some(home.path()), None)
                .expect("openclaw dir")
                .join(OPENCLAW_CONFIG_FILE_NAME)
        )
    );
}

#[test]
fn setup_honors_explicit_connector_url_and_custom_peers_path() {
    let home = TempDir::new().expect("temp home");
    let bin_dir = install_mock_openclaw_cli();
    write_openclaw_profile(
        home.path(),
        r#"{
  "gateway": {
    "auth": {
      "mode": "password",
      "password": "existing-password"
    }
  }
}
"#,
    );
    let provider = OpenclawProvider::with_test_context(
        home.path().to_path_buf(),
        vec![bin_dir.path().to_path_buf()],
    );
    let openclaw_dir = resolve_openclaw_dir(Some(home.path()), None).expect("openclaw dir");
    let custom_peers_path = home.path().join("runtime").join("custom-peers.json");

    let result = provider
        .setup(&ProviderSetupOptions {
            home_dir: None,
            agent_name: Some("alpha".to_string()),
            platform_base_url: Some("http://127.0.0.1:19001".to_string()),
            webhook_host: None,
            webhook_port: None,
            webhook_token: Some("hook-token".to_string()),
            connector_base_url: Some("https://relay.example.test:24444".to_string()),
            connector_url: None,
            relay_transform_peers_path: Some(custom_peers_path.display().to_string()),
        })
        .expect("setup");

    assert!(
        result
            .updated_paths
            .iter()
            .any(|path| path == &custom_peers_path.display().to_string())
    );
    assert!(custom_peers_path.exists());
    assert!(!transform_peers_path(&openclaw_dir).exists());

    let runtime_path = transform_runtime_path(&openclaw_dir);
    let runtime: Value =
        serde_json::from_str(&fs::read_to_string(&runtime_path).expect("runtime body"))
            .expect("runtime json");
    assert_eq!(
        runtime.get("connectorBaseUrl").and_then(Value::as_str),
        Some("https://relay.example.test:24444/")
    );
    assert_eq!(
        runtime
            .get("connectorBaseUrls")
            .and_then(Value::as_array)
            .map(|entries| { entries.iter().filter_map(Value::as_str).collect::<Vec<_>>() }),
        Some(vec!["https://relay.example.test:24444/"])
    );
    assert_eq!(
        runtime.get("peersConfigPath").and_then(Value::as_str),
        Some(custom_peers_path.to_string_lossy().as_ref())
    );

    let config_dir = get_config_dir(&ConfigPathOptions {
        home_dir: Some(home.path().to_path_buf()),
        registry_url_hint: None,
    })
    .expect("config dir");
    let assignments = load_connector_assignments(&config_dir).expect("assignments");
    assert_eq!(
        assignments
            .agents
            .get("alpha")
            .map(|entry| entry.connector_base_url.as_str()),
        Some("https://relay.example.test:24444/")
    );

    let config_body =
        fs::read_to_string(openclaw_dir.join(super::OPENCLAW_CONFIG_FILE_NAME)).expect("config");
    let config: Value = serde_json::from_str(&config_body).expect("config json");
    assert_eq!(
        config
            .get("gateway")
            .and_then(Value::as_object)
            .and_then(|value| value.get("auth"))
            .and_then(Value::as_object)
            .and_then(|value| value.get("mode"))
            .and_then(Value::as_str),
        Some("password")
    );
}

#[test]
fn install_requires_openclaw_cli() {
    let home = TempDir::new().expect("temp home");
    write_openclaw_profile(
        home.path(),
        r#"{
  "gateway": {
    "auth": {
      "mode": "token",
      "token": "gateway-token"
    }
  }
}
"#,
    );
    let provider = OpenclawProvider::with_test_context(home.path().to_path_buf(), Vec::new());

    let error = provider
        .install(&InstallOptions {
            home_dir: Some(home.path().to_path_buf()),
            ..InstallOptions::default()
        })
        .expect_err("missing openclaw CLI should fail");

    assert!(error.to_string().contains("OpenClaw CLI is required"));
}

#[test]
fn doctor_does_not_require_openclaw_cli() {
    let home = TempDir::new().expect("temp home");
    let provider = OpenclawProvider::with_test_context(home.path().to_path_buf(), Vec::new());

    let result = provider
        .doctor(&ProviderDoctorOptions {
            home_dir: Some(home.path().to_path_buf()),
            include_connector_runtime_check: false,
            ..ProviderDoctorOptions::default()
        })
        .expect("doctor should inspect local state without the openclaw CLI");

    assert_eq!(
        result
            .checks
            .iter()
            .find(|check| check.id == "state.openclawConfig")
            .map(|check| check.message.as_str()),
        Some("OpenClaw config is missing")
    );
}

#[test]
fn setup_requires_openclaw_onboarding_first() {
    let home = TempDir::new().expect("temp home");
    let bin_dir = install_mock_openclaw_cli();
    let provider = OpenclawProvider::with_test_context(
        home.path().to_path_buf(),
        vec![bin_dir.path().to_path_buf()],
    );

    let error = provider
        .setup(&ProviderSetupOptions {
            agent_name: Some("alpha".to_string()),
            ..ProviderSetupOptions::default()
        })
        .expect_err("missing openclaw config should fail");

    assert!(error.to_string().contains("openclaw onboard"));
}
