use std::fs;
use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use tempfile::TempDir;
use wiremock::matchers::{header_exists, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use crate::config::{CliConfig, ConfigPathOptions, write_config};

use super::{
    AgentAuthRecord, CreateAgentInput, create_agent, inspect_agent, refresh_agent_auth,
    revoke_agent_auth,
};

fn options(home: &Path, registry_url: &str) -> ConfigPathOptions {
    ConfigPathOptions {
        home_dir: Some(home.to_path_buf()),
        registry_url_hint: Some(registry_url.to_string()),
    }
}

fn seed_config(options: &ConfigPathOptions, registry_url: &str) {
    let config = CliConfig {
        registry_url: registry_url.to_string(),
        proxy_url: None,
        api_key: Some("pat_local_test".to_string()),
        human_name: Some("alice".to_string()),
    };
    let _ = write_config(&config, options).expect("seed config");
}

fn test_ait(agent_did: &str) -> String {
    let header = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&serde_json::json!({
            "alg": "EdDSA",
            "typ": "JWT",
            "kid": "test-kid",
        }))
        .expect("header"),
    );
    let payload = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&serde_json::json!({
            "sub": agent_did,
            "ownerDid": "did:cdi:registry.clawdentity.com:human:01HF7YAT31JZHSMW1CG6Q6MHB7",
            "exp": 2_208_988_800_u64,
            "framework": "openclaw",
            "cnf": { "jwk": { "kty": "OKP", "crv": "Ed25519", "x": "public-key-b64url" } }
        }))
        .expect("payload"),
    );
    format!("{header}.{payload}.local")
}

#[tokio::test]
async fn create_and_inspect_agent_round_trip() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/agents/challenge"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "challengeId": "01JCHALLENGEID1234567890ABC",
            "nonce": "nonce-b64url",
            "ownerDid": "did:cdi:registry.clawdentity.com:human:01HF7YAT31JZHSMW1CG6Q6MHB7",
            "expiresAt": "2030-01-01T00:00:00.000Z",
            "algorithm": "Ed25519",
            "messageTemplate": "clawdentity.register.v1",
        })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/agents"))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "agent": {
                "did": "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
                "name": "alpha",
                "framework": "openclaw",
                "expiresAt": "2030-01-01T00:00:00.000Z"
            },
            "ait": test_ait("did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4"),
            "agentAuth": {
                "tokenType": "Bearer",
                "accessToken": "clw_agt_access_token",
                "accessExpiresAt": "2030-01-01T01:00:00.000Z",
                "refreshToken": "clw_rft_refresh_token",
                "refreshExpiresAt": "2030-01-02T00:00:00.000Z"
            }
        })))
        .mount(&server)
        .await;

    let tmp = TempDir::new().expect("temp dir");
    let options = options(tmp.path(), &server.uri());
    seed_config(&options, &server.uri());

    let create_options = options.clone();
    let created = tokio::task::spawn_blocking(move || {
        create_agent(
            &create_options,
            CreateAgentInput {
                name: "alpha".to_string(),
                framework: Some("openclaw".to_string()),
                ttl_days: Some(30),
            },
        )
    })
    .await
    .expect("join")
    .expect("create");
    assert_eq!(created.name, "alpha");
    assert_eq!(
        created.did,
        "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4"
    );

    let inspect_options = options.clone();
    let inspect = tokio::task::spawn_blocking(move || inspect_agent(&inspect_options, "alpha"))
        .await
        .expect("join")
        .expect("inspect");
    assert_eq!(inspect.framework, "openclaw");
    assert_eq!(inspect.did, created.did);
    assert_eq!(
        inspect.owner_did,
        "did:cdi:registry.clawdentity.com:human:01HF7YAT31JZHSMW1CG6Q6MHB7"
    );

    let auth_path = tmp
        .path()
        .join(".clawdentity/states/local/agents/alpha/registry-auth.json");
    let auth: AgentAuthRecord = super::read_json(&auth_path).expect("auth json");
    assert_eq!(auth.token_type, "Bearer");
    assert_eq!(auth.refresh_token, "clw_rft_refresh_token");
}

#[tokio::test]
async fn refresh_agent_auth_updates_registry_auth_bundle() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/agents/challenge"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "challengeId": "01JCHALLENGEID1234567890ABC",
            "nonce": "nonce-b64url",
            "ownerDid": "did:cdi:registry.clawdentity.com:human:01HF7YAT31JZHSMW1CG6Q6MHB7",
            "expiresAt": "2030-01-01T00:00:00.000Z",
        })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/agents"))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "agent": {
                "did": "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
                "name": "beta",
                "framework": "openclaw",
                "expiresAt": "2030-01-01T00:00:00.000Z"
            },
            "ait": test_ait("did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4"),
            "agentAuth": {
                "tokenType": "Bearer",
                "accessToken": "clw_agt_old_access_token",
                "accessExpiresAt": "2030-01-01T01:00:00.000Z",
                "refreshToken": "clw_rft_old_refresh_token",
                "refreshExpiresAt": "2030-01-02T00:00:00.000Z"
            }
        })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/agents/auth/refresh"))
        .and(header_exists("x-claw-timestamp"))
        .and(header_exists("x-claw-nonce"))
        .and(header_exists("x-claw-body-sha256"))
        .and(header_exists("x-claw-proof"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "agentAuth": {
                "tokenType": "Bearer",
                "accessToken": "clw_agt_new_access_token",
                "accessExpiresAt": "2030-01-03T01:00:00.000Z",
                "refreshToken": "clw_rft_new_refresh_token",
                "refreshExpiresAt": "2030-01-04T00:00:00.000Z"
            }
        })))
        .mount(&server)
        .await;

    let tmp = TempDir::new().expect("temp dir");
    let options = options(tmp.path(), &server.uri());
    seed_config(&options, &server.uri());
    let create_options = options.clone();
    let _ = tokio::task::spawn_blocking(move || {
        create_agent(
            &create_options,
            CreateAgentInput {
                name: "beta".to_string(),
                framework: None,
                ttl_days: None,
            },
        )
    })
    .await
    .expect("join")
    .expect("create");

    let refresh_options = options.clone();
    let refreshed =
        tokio::task::spawn_blocking(move || refresh_agent_auth(&refresh_options, "beta"))
            .await
            .expect("join")
            .expect("refresh");
    assert_eq!(refreshed.status, "refreshed");

    let auth_path = tmp
        .path()
        .join(".clawdentity/states/local/agents/beta/registry-auth.json");
    let auth: AgentAuthRecord = super::read_json(&auth_path).expect("auth json");
    assert_eq!(auth.access_token, "clw_agt_new_access_token");
    assert_eq!(auth.refresh_token, "clw_rft_new_refresh_token");
}

#[test]
fn auth_revoke_returns_not_supported() {
    let tmp = TempDir::new().expect("temp dir");
    let options = options(tmp.path(), "https://registry.clawdentity.com");
    seed_config(&options, "https://registry.clawdentity.com");

    let agent_dir = tmp.path().join(".clawdentity/states/prod/agents/gamma");
    fs::create_dir_all(&agent_dir).expect("agent dir");
    fs::write(
            agent_dir.join("registry-auth.json"),
            "{\n  \"tokenType\": \"Bearer\",\n  \"accessToken\": \"a\",\n  \"accessExpiresAt\": \"b\",\n  \"refreshToken\": \"c\",\n  \"refreshExpiresAt\": \"d\"\n}\n",
        )
        .expect("auth");
    let result = revoke_agent_auth(&options, "gamma").expect("revoke");
    assert_eq!(result.status, "not_supported");
}
