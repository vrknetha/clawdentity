use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use tempfile::TempDir;
use wiremock::matchers::{body_json, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use crate::db::SqliteStore;
use crate::qr::encode_ticket_qr_png;

use super::{
    PairConfirmInput, PairProfile, PairStatusKind, PairStatusOptions, confirm_pairing,
    get_pairing_status, parse_pairing_ticket, parse_pairing_ticket_issuer_origin, start_pairing,
};

fn seed_agent_material(config_dir: &Path, agent_name: &str) {
    let agent_dir = config_dir.join("agents").join(agent_name);
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let header = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&serde_json::json!({"alg":"EdDSA","typ":"JWT","kid":"k1"}))
            .expect("header"),
    );
    let payload = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&serde_json::json!({
            "sub":"did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
            "ownerDid":"did:cdi:registry.clawdentity.com:human:01HF7YAT31JZHSMW1CG6Q6MHB7",
            "exp": 2208988800_u64,
            "framework":"generic",
            "cnf": {"jwk":{"kty":"OKP","crv":"Ed25519","x":"abc"}}
        }))
        .expect("payload"),
    );
    std::fs::write(
        agent_dir.join("ait.jwt"),
        format!("{header}.{payload}.local"),
    )
    .expect("ait");
    std::fs::write(
        agent_dir.join("secret.key"),
        URL_SAFE_NO_PAD.encode([7_u8; 32]),
    )
    .expect("secret");
}

#[test]
fn pairing_ticket_parsing_round_trip() {
    let payload = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&serde_json::json!({
            "iss":"https://proxy.example",
            "sub":"did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
        }))
        .expect("payload"),
    );
    let ticket = format!("clwpair1_{payload}");
    assert_eq!(parse_pairing_ticket(&ticket).expect("ticket"), ticket);
    assert_eq!(
        parse_pairing_ticket_issuer_origin(&ticket).expect("origin"),
        "https://proxy.example"
    );
}

#[tokio::test]
async fn start_confirm_and_status_flow() {
    let server = MockServer::start().await;
    let ticket_payload = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&serde_json::json!({
            "iss": server.uri(),
            "sub":"did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4"
        }))
        .expect("payload"),
    );
    let ticket = format!("clwpair1_{ticket_payload}");

    Mock::given(method("POST"))
        .and(path("/pair/start"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "ticket": ticket,
            "initiatorAgentDid": "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
            "initiatorProfile": { "agentName":"alpha", "humanName":"alice" },
            "expiresAt": "2030-01-01T00:00:00.000Z"
        })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
            .and(path("/pair/confirm"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "paired": true,
                "initiatorAgentDid": "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
                "initiatorProfile": { "agentName":"alpha", "humanName":"alice", "proxyOrigin": server.uri() },
                "responderAgentDid": "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT5",
                "responderProfile": { "agentName":"beta", "humanName":"bob" }
            })))
            .mount(&server)
            .await;
    Mock::given(method("POST"))
            .and(path("/pair/status"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "status": "confirmed",
                "initiatorAgentDid": "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
                "initiatorProfile": { "agentName":"alpha", "humanName":"alice", "proxyOrigin": server.uri() },
                "responderAgentDid": "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
                "responderProfile": { "agentName":"beta", "humanName":"bob" },
                "expiresAt": "2030-01-01T00:00:00.000Z",
                "confirmedAt": "2030-01-01T00:00:10.000Z"
            })))
            .mount(&server)
            .await;

    let temp = TempDir::new().expect("temp dir");
    seed_agent_material(temp.path(), "alpha");
    let store = SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("db");

    let start_temp = temp.path().to_path_buf();
    let start_server_uri = server.uri();
    let start = tokio::task::spawn_blocking(move || {
        start_pairing(
            &start_temp,
            "alpha",
            &start_server_uri,
            PairProfile {
                agent_name: "alpha".to_string(),
                human_name: "alice".to_string(),
                proxy_origin: None,
            },
            None,
        )
    })
    .await
    .expect("join")
    .expect("start");
    assert_eq!(start.ticket, ticket);

    let qr_path = temp.path().join("ticket.png");
    let png = encode_ticket_qr_png(&ticket).expect("qr");
    std::fs::write(&qr_path, png).expect("qr file");
    let confirm_temp = temp.path().to_path_buf();
    let confirm_store = store.clone();
    let confirm = tokio::task::spawn_blocking(move || {
        confirm_pairing(
            &confirm_temp,
            &confirm_store,
            "alpha",
            PairConfirmInput::QrFile(qr_path),
            PairProfile {
                agent_name: "beta".to_string(),
                human_name: "bob".to_string(),
                proxy_origin: None,
            },
        )
    })
    .await
    .expect("join")
    .expect("confirm");
    assert!(confirm.paired);

    let status_temp = temp.path().to_path_buf();
    let status_store = store.clone();
    let status_server_uri = server.uri();
    let status_ticket = ticket.clone();
    let status = tokio::task::spawn_blocking(move || {
        get_pairing_status(
            &status_temp,
            &status_store,
            "alpha",
            &status_server_uri,
            &status_ticket,
            PairStatusOptions {
                wait: false,
                wait_seconds: 1,
                poll_interval_seconds: 1,
            },
        )
    })
    .await
    .expect("join")
    .expect("status");
    assert_eq!(status.status, PairStatusKind::Confirmed);
}

#[tokio::test]
async fn start_pairing_omits_ttl_seconds_when_not_provided() {
    let server = MockServer::start().await;
    let ticket_payload = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&serde_json::json!({
            "iss": server.uri(),
            "sub":"did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4"
        }))
        .expect("payload"),
    );
    let ticket = format!("clwpair1_{ticket_payload}");

    Mock::given(method("POST"))
        .and(path("/pair/start"))
        .and(body_json(serde_json::json!({
            "initiatorProfile": { "agentName":"alpha", "humanName":"alice" }
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "ticket": ticket,
            "initiatorAgentDid": "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
            "initiatorProfile": { "agentName":"alpha", "humanName":"alice" },
            "expiresAt": "2030-01-01T00:00:00.000Z"
        })))
        .mount(&server)
        .await;

    let temp = TempDir::new().expect("temp dir");
    seed_agent_material(temp.path(), "alpha");
    let start_temp = temp.path().to_path_buf();
    let start_server_uri = server.uri();

    let start = tokio::task::spawn_blocking(move || {
        start_pairing(
            &start_temp,
            "alpha",
            &start_server_uri,
            PairProfile {
                agent_name: "alpha".to_string(),
                human_name: "alice".to_string(),
                proxy_origin: None,
            },
            None,
        )
    })
    .await
    .expect("join")
    .expect("start");

    assert_eq!(start.ticket, ticket);
}
