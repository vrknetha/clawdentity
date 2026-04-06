use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use chrono::Utc;
use clawdentity_core::config::{CliConfig, ConfigPathOptions, get_config_dir, write_config};
use clawdentity_core::constants::{AGENTS_DIR, AIT_FILE_NAME, SECRET_KEY_FILE_NAME};
use sha2::{Digest, Sha256};

pub(super) fn encode_base64url(input: &[u8]) -> String {
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

pub(super) fn fixture_ait_with_framework(framework: &str) -> String {
    let header = r#"{"alg":"EdDSA","kid":"key-1","typ":"JWT"}"#;
    let payload = format!(
        "{{\"sub\":\"did:cdi:test:agent:alpha\",\"ownerDid\":\"did:cdi:test:human:owner\",\"cnf\":{{\"jwk\":{{\"x\":\"public-key-x\"}}}},\"exp\":4102444800,\"framework\":\"{framework}\"}}"
    );
    format!(
        "{}.{}.sig",
        encode_base64url(header.as_bytes()),
        encode_base64url(payload.as_bytes())
    )
}

pub(super) fn hmac_sha256_hex(secret: &str, payload: &[u8]) -> String {
    const BLOCK_SIZE: usize = 64;
    let mut key = secret.as_bytes().to_vec();
    if key.len() > BLOCK_SIZE {
        key = Sha256::digest(&key).to_vec();
    }
    if key.len() < BLOCK_SIZE {
        key.resize(BLOCK_SIZE, 0);
    }

    let mut ipad = vec![0x36; BLOCK_SIZE];
    let mut opad = vec![0x5c; BLOCK_SIZE];
    for (index, value) in key.iter().enumerate() {
        ipad[index] ^= value;
        opad[index] ^= value;
    }

    let mut inner = Sha256::new();
    inner.update(&ipad);
    inner.update(payload);
    let inner_hash = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(&opad);
    outer.update(inner_hash);
    let digest = outer.finalize();
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

static RECEIPT_FIXTURE_COUNTER: AtomicU64 = AtomicU64::new(1);

pub(super) fn setup_receipt_header_fixture() -> (ConfigPathOptions, String) {
    setup_receipt_header_fixture_with_registry("https://registry.example")
}

pub(super) fn setup_receipt_header_fixture_with_registry(
    registry_url: &str,
) -> (ConfigPathOptions, String) {
    let options = receipt_fixture_options();
    write_receipt_fixture_config(&options, registry_url);

    let agent_name = "alpha".to_string();
    write_receipt_fixture_agent_files(&options, &agent_name);
    (options, agent_name)
}

pub(super) fn receipt_fixture_options() -> ConfigPathOptions {
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

pub(super) fn write_receipt_fixture_config(options: &ConfigPathOptions, registry_url: &str) {
    write_config(
        &CliConfig {
            registry_url: registry_url.to_string(),
            proxy_url: Some("https://proxy.example".to_string()),
            api_key: None,
            human_name: Some("Tester".to_string()),
        },
        options,
    )
    .expect("write config");
}

pub(super) fn write_receipt_fixture_agent_files(options: &ConfigPathOptions, agent_name: &str) {
    write_receipt_fixture_agent_files_with_framework(options, agent_name, "openclaw");
}

pub(super) fn write_receipt_fixture_agent_files_with_framework(
    options: &ConfigPathOptions,
    agent_name: &str,
    framework: &str,
) {
    let config_dir = get_config_dir(options).expect("resolve config dir");
    let agent_dir = config_dir.join(AGENTS_DIR).join(agent_name);
    fs::create_dir_all(&agent_dir).expect("create agent dir");

    write_receipt_fixture_ait(&agent_dir, framework);
    write_receipt_fixture_secret_key(&agent_dir);
    write_receipt_fixture_auth(&agent_dir);
}

fn write_receipt_fixture_ait(agent_dir: &Path, framework: &str) {
    fs::write(
        agent_dir.join(AIT_FILE_NAME),
        format!("{}\n", fixture_ait_with_framework(framework)),
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
