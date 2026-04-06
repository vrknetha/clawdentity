use std::fs;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{SigningKey, VerifyingKey};
use tempfile::tempdir;
use wiremock::matchers::{body_json, header_exists, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use crate::config::{CliConfig, ConfigPathOptions, get_config_dir, write_config};
use crate::constants::{AGENTS_DIR, AIT_FILE_NAME, SECRET_KEY_FILE_NAME};

use super::{
    GroupCreateInput, GroupJoinInput, GroupJoinTokenCreateInput, GroupJoinTokenResetInput,
    GroupJoinTokenRevokeInput, GroupRole, create_group, create_group_join_token,
    fetch_group_member_dids_with_agent_auth, fetch_group_name_with_agent_auth, join_group,
    parse_group_join_token, parse_group_name, reset_group_join_token, revoke_group_join_token,
};

fn fake_ait(agent_did: &str, owner_did: &str, public_key: &str) -> String {
    let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"EdDSA","kid":"test-kid"}"#);
    let payload = URL_SAFE_NO_PAD.encode(format!(
        "{{\"sub\":\"{agent_did}\",\"ownerDid\":\"{owner_did}\",\"framework\":\"openclaw\",\"cnf\":{{\"jwk\":{{\"x\":\"{public_key}\"}}}},\"exp\":2524608000}}"
    ));
    format!("{header}.{payload}.sig")
}

fn seed_agent_state(options: &ConfigPathOptions, agent_name: &str, registry_url: &str) {
    write_config(
        &CliConfig {
            registry_url: registry_url.to_string(),
            proxy_url: None,
            api_key: None,
            human_name: None,
        },
        options,
    )
    .expect("write config");

    let config_dir = get_config_dir(options).expect("config dir");
    let agent_dir = config_dir.join(AGENTS_DIR).join(agent_name);
    fs::create_dir_all(&agent_dir).expect("agent dir");

    let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
    let verifying_key: VerifyingKey = signing_key.verifying_key();
    let secret_key = URL_SAFE_NO_PAD.encode(signing_key.to_bytes());
    let public_key = URL_SAFE_NO_PAD.encode(verifying_key.as_bytes());
    let agent_did = "did:cdi:127.0.0.1:agent:01HF7YAT31JZHSMW1CG6Q6MHB7";
    let owner_did = "did:cdi:127.0.0.1:human:01HF7YAT31JZHSMW1CG6Q6MHB8";

    fs::write(
        agent_dir.join(AIT_FILE_NAME),
        fake_ait(agent_did, owner_did, &public_key),
    )
    .expect("write ait");
    fs::write(agent_dir.join(SECRET_KEY_FILE_NAME), secret_key).expect("write secret");
    fs::write(
        agent_dir.join("registry-auth.json"),
        "{\"tokenType\":\"Bearer\",\"accessToken\":\"agent-access-token\",\"accessExpiresAt\":\"2030-01-01T00:00:00.000Z\",\"refreshToken\":\"refresh-token\",\"refreshExpiresAt\":\"2030-01-02T00:00:00.000Z\"}",
    )
    .expect("write auth");
}

#[test]
fn parse_group_join_token_rejects_invalid_token() {
    assert!(parse_group_join_token("bad_token").is_err());
    assert!(parse_group_join_token("clw_gjt_").is_err());
}

#[test]
fn parse_group_name_counts_characters_not_bytes() {
    let eighty_cjk_chars = "你".repeat(80);
    let eighty_one_cjk_chars = "你".repeat(81);

    assert!(parse_group_name(&eighty_cjk_chars).is_ok());
    assert!(parse_group_name(&eighty_one_cjk_chars).is_err());
}

#[tokio::test]
async fn group_endpoints_use_signed_agent_auth_headers() {
    let server = MockServer::start().await;
    let home = tempdir().expect("tempdir");
    let options = ConfigPathOptions {
        home_dir: Some(home.path().to_path_buf()),
        registry_url_hint: Some(server.uri()),
    };
    seed_agent_state(&options, "alpha", &server.uri());

    Mock::given(method("POST"))
        .and(path("/v1/groups"))
        .and(header_exists("authorization"))
        .and(header_exists("x-claw-agent-access"))
        .and(header_exists("x-claw-proof"))
        .and(body_json(serde_json::json!({ "name": "research-crew" })))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "group": {
                "id": "grp_01HF7YAT31JZHSMW1CG6Q6MHB7",
                "name": "research-crew"
            }
        })))
        .mount(&server)
        .await;

    let created = create_group(
        &options,
        GroupCreateInput {
            agent_name: "alpha".to_string(),
            name: "research-crew".to_string(),
        },
    )
    .await
    .expect("group create");
    assert_eq!(created.group.name, "research-crew");
}

#[tokio::test]
async fn group_join_token_create_uses_current_active_contract() {
    let server = MockServer::start().await;
    let home = tempdir().expect("tempdir");
    let options = ConfigPathOptions {
        home_dir: Some(home.path().to_path_buf()),
        registry_url_hint: Some(server.uri()),
    };
    seed_agent_state(&options, "alpha", &server.uri());

    Mock::given(method("POST"))
        .and(path(
            "/v1/groups/grp_01HF7YAT31JZHSMW1CG6Q6MHB7/join-tokens",
        ))
        .and(body_json(serde_json::json!({})))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "groupJoinToken": {
                "id": "01HF7YAT31JZHSMW1CG6Q6MHB7",
                "token": "clw_gjt_abc123",
                "groupId": "grp_01HF7YAT31JZHSMW1CG6Q6MHB7",
                "role": "member",
                "createdAt": "2026-03-01T00:00:00.000Z",
                "active": true
            }
        })))
        .mount(&server)
        .await;

    let created = create_group_join_token(
        &options,
        GroupJoinTokenCreateInput {
            agent_name: "alpha".to_string(),
            group_id: "grp_01HF7YAT31JZHSMW1CG6Q6MHB7".to_string(),
        },
    )
    .await
    .expect("group join token");
    assert_eq!(created.group_join_token.token, "clw_gjt_abc123");
    assert!(created.group_join_token.active);
}

#[tokio::test]
async fn group_join_token_reset_and_revoke_call_new_routes() {
    let server = MockServer::start().await;
    let home = tempdir().expect("tempdir");
    let options = ConfigPathOptions {
        home_dir: Some(home.path().to_path_buf()),
        registry_url_hint: Some(server.uri()),
    };
    seed_agent_state(&options, "alpha", &server.uri());

    Mock::given(method("POST"))
        .and(path(
            "/v1/groups/grp_01HF7YAT31JZHSMW1CG6Q6MHB7/join-tokens/reset",
        ))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "groupJoinToken": {
                "id": "01HF7YAT31JZHSMW1CG6Q6MHB8",
                "token": "clw_gjt_reset123",
                "groupId": "grp_01HF7YAT31JZHSMW1CG6Q6MHB7",
                "role": "member",
                "createdAt": "2026-03-02T00:00:00.000Z",
                "active": true
            }
        })))
        .mount(&server)
        .await;
    Mock::given(method("DELETE"))
        .and(path(
            "/v1/groups/grp_01HF7YAT31JZHSMW1CG6Q6MHB7/join-tokens/current",
        ))
        .respond_with(ResponseTemplate::new(204))
        .mount(&server)
        .await;

    let reset = reset_group_join_token(
        &options,
        GroupJoinTokenResetInput {
            agent_name: "alpha".to_string(),
            group_id: "grp_01HF7YAT31JZHSMW1CG6Q6MHB7".to_string(),
        },
    )
    .await
    .expect("reset");
    assert_eq!(reset.group_join_token.token, "clw_gjt_reset123");

    let revoked = revoke_group_join_token(
        &options,
        GroupJoinTokenRevokeInput {
            agent_name: "alpha".to_string(),
            group_id: "grp_01HF7YAT31JZHSMW1CG6Q6MHB7".to_string(),
        },
    )
    .await
    .expect("revoke");
    assert!(revoked.revoked);
}

#[tokio::test]
async fn group_read_helpers_parse_group_and_members() {
    let server = MockServer::start().await;
    let home = tempdir().expect("tempdir");
    let options = ConfigPathOptions {
        home_dir: Some(home.path().to_path_buf()),
        registry_url_hint: Some(server.uri()),
    };
    seed_agent_state(&options, "alpha", &server.uri());

    Mock::given(method("GET"))
        .and(path("/v1/groups/grp_01HF7YAT31JZHSMW1CG6Q6MHB7"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "group": {
                "id": "grp_01HF7YAT31JZHSMW1CG6Q6MHB7",
                "name": "research-crew"
            }
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v1/groups/grp_01HF7YAT31JZHSMW1CG6Q6MHB7/members"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "group": {
                "id": "grp_01HF7YAT31JZHSMW1CG6Q6MHB7"
            },
            "members": [{
                "agentDid": "did:cdi:127.0.0.1:agent:01HF7YAT31JZHSMW1CG6Q6MHB9",
                "agentName": "beta",
                "displayName": "Beta User",
                "framework": "openclaw",
                "humanDid": "did:cdi:127.0.0.1:human:01HF7YAT31JZHSMW1CG6Q6MHC1",
                "status": "active",
                "role": "member",
                "joinedAt": "2026-03-01T00:00:00.000Z"
            }]
        })))
        .mount(&server)
        .await;

    let group_name =
        fetch_group_name_with_agent_auth(&options, "alpha", "grp_01HF7YAT31JZHSMW1CG6Q6MHB7")
            .await
            .expect("group name");
    assert_eq!(group_name, "research-crew");

    let members = fetch_group_member_dids_with_agent_auth(
        &options,
        "alpha",
        "grp_01HF7YAT31JZHSMW1CG6Q6MHB7",
    )
    .await
    .expect("group members");
    assert_eq!(members.len(), 1);
    assert_eq!(
        members[0],
        "did:cdi:127.0.0.1:agent:01HF7YAT31JZHSMW1CG6Q6MHB9"
    );
}

#[tokio::test]
async fn group_join_parses_response() {
    let server = MockServer::start().await;
    let home = tempdir().expect("tempdir");
    let options = ConfigPathOptions {
        home_dir: Some(home.path().to_path_buf()),
        registry_url_hint: Some(server.uri()),
    };
    seed_agent_state(&options, "alpha", &server.uri());

    Mock::given(method("POST"))
        .and(path("/v1/groups/join"))
        .and(body_json(serde_json::json!({
            "groupJoinToken": "clw_gjt_abc123"
        })))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "joined": true,
            "groupId": "grp_01HF7YAT31JZHSMW1CG6Q6MHB7",
            "agentDid": "did:cdi:127.0.0.1:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
            "role": "member",
            "joinedAt": "2026-03-01T00:00:00.000Z"
        })))
        .mount(&server)
        .await;

    let joined = join_group(
        &options,
        GroupJoinInput {
            agent_name: "alpha".to_string(),
            group_join_token: "clw_gjt_abc123".to_string(),
        },
    )
    .await
    .expect("group join");
    assert!(joined.joined);
    assert_eq!(joined.role, GroupRole::Member);
}
