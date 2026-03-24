use std::fs;

use serde_json::Value;
use tempfile::TempDir;

use super::{
    SKILL_DIR_NAME, install_openclaw_skill_assets, patch_openclaw_config, skill_root,
    transform_runtime_path, verify_openclaw_install, write_transform_peers_snapshot,
    write_transform_runtime_config,
};
use crate::peers::PeersConfig;
use crate::providers::openclaw::test_support::{install_mock_openclaw_cli, write_openclaw_profile};

#[test]
fn installs_skill_assets_and_writes_runtime_files() {
    let temp = TempDir::new().expect("temp dir");
    let notes = install_openclaw_skill_assets(temp.path()).expect("install assets");
    assert!(!notes.is_empty());
    assert!(skill_root(temp.path()).join("SKILL.md").exists());
    assert!(
        skill_root(temp.path())
            .join("references/clawdentity-protocol.md")
            .exists()
    );

    let peers_target = temp.path().join("custom").join("peers.json");
    let runtime_path = write_transform_runtime_config(
        temp.path(),
        "https://relay.example.test:24444",
        &peers_target,
    )
    .expect("runtime");
    assert_eq!(runtime_path, transform_runtime_path(temp.path()));
    let runtime_value: Value =
        serde_json::from_str(&fs::read_to_string(&runtime_path).expect("runtime body"))
            .expect("runtime json");
    assert_eq!(
        runtime_value
            .get("connectorBaseUrl")
            .and_then(Value::as_str),
        Some("https://relay.example.test:24444/")
    );
    assert_eq!(
        runtime_value
            .get("connectorBaseUrls")
            .and_then(Value::as_array)
            .map(|entries| { entries.iter().filter_map(Value::as_str).collect::<Vec<_>>() }),
        Some(vec!["https://relay.example.test:24444/"])
    );
    assert_eq!(
        runtime_value.get("peersConfigPath").and_then(Value::as_str),
        Some(peers_target.to_string_lossy().as_ref())
    );
    let peers_path = write_transform_peers_snapshot(
        &peers_target,
        &PeersConfig {
            peers: Default::default(),
        },
    )
    .expect("peers snapshot");
    assert!(peers_path.exists());
}

#[test]
fn installs_skill_assets_with_local_site_urls_when_profile_env_overrides_them() {
    let temp = TempDir::new().expect("temp dir");
    fs::write(
        temp.path().join(".env"),
        "CLAWDENTITY_SITE_BASE_URL=http://localhost:4321\n",
    )
    .expect("profile env");

    install_openclaw_skill_assets(temp.path()).expect("install assets");

    let skill_markdown =
        fs::read_to_string(skill_root(temp.path()).join("SKILL.md")).expect("skill markdown");
    assert!(skill_markdown.contains("http://localhost:4321/skill.md"));
    assert!(skill_markdown.contains("http://localhost:4321/install.sh"));
    assert!(skill_markdown.contains("http://localhost:4321/install.ps1"));
}

#[test]
fn patches_config_for_hook_mapping_without_overwriting_gateway_auth() {
    let temp = TempDir::new().expect("temp dir");
    let bin_dir = install_mock_openclaw_cli();
    let config_path = write_openclaw_profile(
        temp.path(),
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
    install_openclaw_skill_assets(temp.path()).expect("install assets");
    let patched = patch_openclaw_config(
        bin_dir.path().join("openclaw").as_path(),
        temp.path(),
        &config_path,
        Some("hook-token"),
    )
    .expect("patch config");
    assert!(patched.config_changed);
    let checks = verify_openclaw_install(&config_path, temp.path()).expect("verify");
    assert!(checks.iter().all(|(_, passed, _)| *passed));
    let config: Value =
        serde_json::from_str(&fs::read_to_string(&config_path).expect("config body"))
            .expect("config json");
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
    assert!(
        temp.path()
            .join("hooks/transforms/relay-to-peer.mjs")
            .exists()
    );
    assert!(
        temp.path()
            .join("skills")
            .join(SKILL_DIR_NAME)
            .join("SKILL.md")
            .exists()
    );
}
