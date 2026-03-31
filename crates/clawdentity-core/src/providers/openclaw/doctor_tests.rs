use std::path::PathBuf;

use tempfile::TempDir;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use super::super::assets::install_openclaw_skill_assets;
use super::super::setup::{
    OPENCLAW_CONFIG_FILE_NAME, OpenclawRelayRuntimeConfig, save_connector_assignment,
    save_relay_runtime_config, write_selected_openclaw_agent,
};
use super::{DoctorStatus, OpenclawDoctorOptions, run_openclaw_doctor};
use crate::config::{CliConfig, ConfigPathOptions, write_config};
use crate::db::SqliteStore;
use crate::peers::{PersistPeerInput, persist_peer};

fn setup_healthy_openclaw_doctor_state(temp: &TempDir) -> (PathBuf, PathBuf, SqliteStore) {
    let config_dir = temp.path().join("state");
    std::fs::create_dir_all(config_dir.join("agents/alpha")).expect("agent dir");
    std::fs::write(config_dir.join("agents/alpha/ait.jwt"), "token").expect("ait");
    std::fs::write(config_dir.join("agents/alpha/secret.key"), "secret").expect("secret");
    write_selected_openclaw_agent(&config_dir, "alpha").expect("selected");
    save_relay_runtime_config(
        &config_dir,
        OpenclawRelayRuntimeConfig {
            openclaw_base_url: "http://127.0.0.1:18789".to_string(),
            openclaw_hook_token: Some("token".to_string()),
            relay_transform_peers_path: None,
            updated_at: None,
        },
    )
    .expect("runtime config");

    let openclaw_dir = temp.path().join("openclaw");
    std::fs::create_dir_all(openclaw_dir.join("hooks/transforms")).expect("transform dir");
    std::fs::write(
        openclaw_dir.join("hooks/transforms/relay-to-peer.mjs"),
        "export default {}",
    )
    .expect("transform");
    install_openclaw_skill_assets(&openclaw_dir).expect("skill assets");
    std::fs::write(
        openclaw_dir.join(OPENCLAW_CONFIG_FILE_NAME),
        r#"{
  "hooks": {
    "enabled": true,
    "token": "token",
    "defaultSessionKey": "main",
    "allowRequestSessionKey": false,
    "allowedSessionKeyPrefixes": ["hook:", "main"],
    "mappings": [
      {
        "id": "clawdentity-send-to-peer",
        "match": { "path": "send-to-peer" },
        "action": "wake",
        "wakeMode": "now",
        "transform": { "module": "relay-to-peer.mjs" }
      }
    ]
  },
  "gateway": {
    "auth": {
      "mode": "token",
      "token": "gateway-token"
    }
  }
}
"#,
    )
    .expect("config");
    std::fs::create_dir_all(openclaw_dir.join("devices")).expect("devices dir");
    std::fs::write(openclaw_dir.join("devices/pending.json"), "[]").expect("pending");

    let store = SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("db");
    (config_dir, openclaw_dir, store)
}

#[tokio::test]
async fn doctor_reports_healthy_when_runtime_is_ready() {
    let temp = TempDir::new().expect("temp dir");
    let (config_dir, openclaw_dir, store) = setup_healthy_openclaw_doctor_state(&temp);
    let _ = persist_peer(
        &store,
        PersistPeerInput {
            alias: Some("peer-alpha".to_string()),
            did: "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4".to_string(),
            proxy_url: "https://proxy.example/hooks/agent".to_string(),
            agent_name: Some("alpha".to_string()),
            display_name: Some("alice".to_string()),
            framework: None,
            description: None,
            last_synced_at_ms: None,
        },
    )
    .expect("peer");

    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/status"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "websocket": { "connected": true },
            "inbound": { "pending": 0, "deadLetter": 0 }
        })))
        .mount(&server)
        .await;

    save_connector_assignment(&config_dir, "alpha", &server.uri(), Some("main"))
        .expect("assignment");
    let doctor_config_dir = config_dir.clone();
    let doctor_store = store.clone();
    let result = tokio::task::spawn_blocking(move || {
        run_openclaw_doctor(
            &doctor_config_dir,
            &doctor_store,
            OpenclawDoctorOptions {
                openclaw_dir: Some(openclaw_dir),
                include_connector_runtime_check: true,
                ..OpenclawDoctorOptions::default()
            },
        )
    })
    .await
    .expect("join")
    .expect("doctor");
    assert_eq!(result.status, DoctorStatus::Healthy);
}

#[test]
fn doctor_warns_when_no_peers_are_configured() {
    let temp = TempDir::new().expect("temp dir");
    let (config_dir, openclaw_dir, store) = setup_healthy_openclaw_doctor_state(&temp);

    let result = run_openclaw_doctor(
        &config_dir,
        &store,
        OpenclawDoctorOptions {
            openclaw_dir: Some(openclaw_dir),
            include_connector_runtime_check: false,
            ..OpenclawDoctorOptions::default()
        },
    )
    .expect("doctor");

    assert_eq!(result.status, DoctorStatus::Healthy);
    assert!(result.checks.iter().any(|check| {
        check.id == "state.peers"
            && check.status == super::DoctorCheckStatus::Warn
            && check.message.contains("no paired peers found")
    }));
}

#[test]
fn doctor_fails_when_requested_peer_alias_is_missing() {
    let temp = TempDir::new().expect("temp dir");
    let (config_dir, openclaw_dir, store) = setup_healthy_openclaw_doctor_state(&temp);

    let result = run_openclaw_doctor(
        &config_dir,
        &store,
        OpenclawDoctorOptions {
            openclaw_dir: Some(openclaw_dir),
            peer_alias: Some("beta".to_string()),
            include_connector_runtime_check: false,
            ..OpenclawDoctorOptions::default()
        },
    )
    .expect("doctor");

    assert_eq!(result.status, DoctorStatus::Unhealthy);
    assert!(result.checks.iter().any(|check| {
        check.id == "state.peers"
            && check.status == super::DoctorCheckStatus::Fail
            && check
                .message
                .contains("peer alias `beta` is not configured")
    }));
}

#[test]
fn doctor_fails_when_selected_agent_marker_is_missing() {
    let temp = TempDir::new().expect("temp dir");
    let config_dir = temp.path().join("state");
    std::fs::create_dir_all(&config_dir).expect("state dir");
    let store = SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("db");
    let result = run_openclaw_doctor(
        &config_dir,
        &store,
        OpenclawDoctorOptions {
            include_connector_runtime_check: false,
            ..OpenclawDoctorOptions::default()
        },
    )
    .expect("doctor");
    assert_eq!(result.status, DoctorStatus::Unhealthy);
    assert!(
        result
            .checks
            .iter()
            .any(|check| check.id == "state.selectedAgent"
                && check.status == super::DoctorCheckStatus::Fail)
    );
}

#[test]
fn doctor_flags_runtime_when_openclaw_base_url_matches_proxy_url() {
    let temp = TempDir::new().expect("temp dir");
    let config_dir = temp.path().join("state");
    std::fs::create_dir_all(&config_dir).expect("state dir");
    write_config(
        &CliConfig {
            registry_url: "https://registry.example.test".to_string(),
            proxy_url: Some("https://proxy.example.test".to_string()),
            api_key: None,
            human_name: Some("Ravi Kiran".to_string()),
        },
        &ConfigPathOptions {
            home_dir: Some(temp.path().to_path_buf()),
            registry_url_hint: None,
        },
    )
    .expect("config");
    write_selected_openclaw_agent(&config_dir, "alpha").expect("selected");
    save_relay_runtime_config(
        &config_dir,
        OpenclawRelayRuntimeConfig {
            openclaw_base_url: "https://proxy.example.test".to_string(),
            openclaw_hook_token: Some("token".to_string()),
            relay_transform_peers_path: None,
            updated_at: None,
        },
    )
    .expect("runtime");

    let openclaw_dir = temp.path().join("openclaw");
    std::fs::create_dir_all(openclaw_dir.join("hooks/transforms")).expect("transform dir");
    std::fs::write(
        openclaw_dir.join(OPENCLAW_CONFIG_FILE_NAME),
        "{\n  \"hooks\": {\"token\": \"token\"}\n}\n",
    )
    .expect("config");
    std::fs::create_dir_all(openclaw_dir.join("devices")).expect("devices dir");
    std::fs::write(openclaw_dir.join("devices/pending.json"), "[]").expect("pending");

    let store = SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("db");
    let result = run_openclaw_doctor(
        &config_dir,
        &store,
        OpenclawDoctorOptions {
            home_dir: Some(temp.path().to_path_buf()),
            openclaw_dir: Some(openclaw_dir),
            include_connector_runtime_check: false,
            ..OpenclawDoctorOptions::default()
        },
    )
    .expect("doctor");

    assert_eq!(result.status, DoctorStatus::Unhealthy);
    assert!(result.checks.iter().any(|check| {
        check.id == "state.openclawBaseUrl"
            && check.status == super::DoctorCheckStatus::Fail
            && check.message.contains("Clawdentity proxy")
    }));
}
