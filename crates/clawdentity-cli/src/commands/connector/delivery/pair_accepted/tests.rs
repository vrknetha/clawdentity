use tempfile::TempDir;

use clawdentity_core::{ConfigPathOptions, list_peers, now_iso};
use serde_json::{Value, json};

use super::{PAIR_ACCEPTED_TEST_OUTAGE_AGENT_NAME, PAIR_ACCEPTED_TRUSTED_DELIVERY_SOURCE};
use super::{apply_pair_accepted_system_delivery, is_trusted_pair_accepted_delivery};

fn test_options() -> ConfigPathOptions {
    ConfigPathOptions {
        home_dir: None,
        registry_url_hint: None,
    }
}

fn fixture_deliver_frame() -> clawdentity_core::DeliverFrame {
    clawdentity_core::DeliverFrame {
        v: clawdentity_core::CONNECTOR_FRAME_VERSION,
        id: "req-pair-accepted-1".to_string(),
        ts: now_iso(),
        from_agent_did: "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97"
            .to_string(),
        to_agent_did: "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7"
            .to_string(),
        group_id: None,
        payload: json!({
            "system": {
                "type": "pair.accepted",
                "initiatorAgentDid": "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
                "responderAgentDid": "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
                "responderProfile": {
                    "agentName": "beta",
                    "displayName": "Ira",
                    "proxyOrigin": "https://beta.proxy.example"
                },
                "issuerProxyOrigin": "https://proxy.clawdentity.dev",
                "eventTimestampUtc": "2026-03-28T00:00:00.000Z"
            }
        }),
        delivery_source: Some(PAIR_ACCEPTED_TRUSTED_DELIVERY_SOURCE.to_string()),
        content_type: Some("application/json".to_string()),
        conversation_id: None,
        reply_to: None,
    }
}

#[tokio::test]
async fn pair_accepted_event_persists_peer_and_updates_notification_payload() {
    let temp = TempDir::new().expect("temp dir");
    let store =
        clawdentity_core::SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("open db");

    let mut deliver = fixture_deliver_frame();
    let handled = apply_pair_accepted_system_delivery(
        &test_options(),
        "alpha",
        &store,
        temp.path(),
        &mut deliver,
    )
    .await
    .expect("apply pair accepted delivery");
    assert!(handled);

    let peers = list_peers(&store).expect("list peers");
    assert_eq!(peers.len(), 1);
    assert_eq!(
        peers[0].did,
        "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97"
    );

    assert_eq!(
        deliver
            .payload
            .get("type")
            .and_then(serde_json::Value::as_str),
        Some("clawdentity:pair-accepted")
    );
    let message = deliver
        .payload
        .get("message")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    assert!(message.contains("Clawdentity pairing accepted"));
}

#[tokio::test]
async fn duplicate_pair_accepted_events_are_idempotent_for_peer_state() {
    let temp = TempDir::new().expect("temp dir");
    let store =
        clawdentity_core::SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("open db");

    let mut first = fixture_deliver_frame();
    apply_pair_accepted_system_delivery(&test_options(), "alpha", &store, temp.path(), &mut first)
        .await
        .expect("first apply");

    let mut second = fixture_deliver_frame();
    apply_pair_accepted_system_delivery(&test_options(), "alpha", &store, temp.path(), &mut second)
        .await
        .expect("second apply");

    let peers = list_peers(&store).expect("list peers");
    assert_eq!(peers.len(), 1);
}

#[tokio::test]
async fn non_system_payload_is_ignored() {
    let temp = TempDir::new().expect("temp dir");
    let store =
        clawdentity_core::SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("open db");
    let mut deliver = fixture_deliver_frame();
    deliver.payload = json!({ "message": "hello" });

    let handled = apply_pair_accepted_system_delivery(
        &test_options(),
        "alpha",
        &store,
        temp.path(),
        &mut deliver,
    )
    .await
    .expect("apply");
    assert!(!handled);
}

#[tokio::test]
async fn pair_accepted_is_ignored_when_delivery_source_is_not_trusted() {
    let temp = TempDir::new().expect("temp dir");
    let store =
        clawdentity_core::SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("open db");
    let mut deliver = fixture_deliver_frame();
    deliver.delivery_source = Some("agent.enqueue".to_string());

    let handled = apply_pair_accepted_system_delivery(
        &test_options(),
        "alpha",
        &store,
        temp.path(),
        &mut deliver,
    )
    .await
    .expect("apply");
    assert!(!handled);
    let peers = list_peers(&store).expect("list peers");
    assert_eq!(peers.len(), 0);
}

#[test]
fn trusted_delivery_requires_queue_delivery_source() {
    let trusted = fixture_deliver_frame();
    assert!(is_trusted_pair_accepted_delivery(&trusted));

    let mut untrusted = fixture_deliver_frame();
    untrusted.delivery_source = Some("agent.enqueue".to_string());
    assert!(!is_trusted_pair_accepted_delivery(&untrusted));
}

#[tokio::test]
async fn pair_accepted_event_normalizes_timestamp_to_utc_rfc3339() {
    let temp = TempDir::new().expect("temp dir");
    let store =
        clawdentity_core::SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("open db");

    let mut deliver = fixture_deliver_frame();
    deliver.payload["system"]["eventTimestampUtc"] = json!("2026-03-28T05:30:00.000+05:30");

    apply_pair_accepted_system_delivery(
        &test_options(),
        "alpha",
        &store,
        temp.path(),
        &mut deliver,
    )
    .await
    .expect("apply");

    assert_eq!(
        deliver
            .payload
            .get("pairAccepted")
            .and_then(|value| value.get("eventTimestampUtc"))
            .and_then(serde_json::Value::as_str),
        Some("2026-03-28T00:00:00.000Z")
    );
}

#[tokio::test]
async fn pair_accepted_notification_prefers_proxy_message_when_present() {
    let temp = TempDir::new().expect("temp dir");
    let store =
        clawdentity_core::SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("open db");

    let mut deliver = fixture_deliver_frame();
    deliver.payload["system"]["message"] =
        json!("Clawdentity pairing complete. You can now message this peer.");

    apply_pair_accepted_system_delivery(
        &test_options(),
        "alpha",
        &store,
        temp.path(),
        &mut deliver,
    )
    .await
    .expect("apply");

    assert_eq!(
        deliver
            .payload
            .get("message")
            .and_then(serde_json::Value::as_str),
        Some("Clawdentity pairing complete. You can now message this peer.")
    );
}

#[tokio::test]
async fn pair_accepted_ignores_blank_proxy_message_and_uses_fallback() {
    let temp = TempDir::new().expect("temp dir");
    let store =
        clawdentity_core::SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("open db");

    let mut deliver = fixture_deliver_frame();
    deliver.payload["system"]["message"] = json!("   ");

    apply_pair_accepted_system_delivery(
        &test_options(),
        "alpha",
        &store,
        temp.path(),
        &mut deliver,
    )
    .await
    .expect("apply");

    let message = deliver
        .payload
        .get("message")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    assert!(message.contains("Clawdentity pairing accepted"));
}

#[tokio::test]
async fn pair_accepted_updates_stale_onboarding_session_to_messaging_ready() {
    let temp = TempDir::new().expect("temp dir");
    let store =
        clawdentity_core::SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("open db");

    std::fs::write(
        temp.path().join("onboarding-session.json"),
        serde_json::to_string_pretty(&json!({
            "version": 1,
            "state": "pairing_pending",
            "platform": "generic",
            "agentName": "alpha-local",
            "displayName": "Alpha Local",
            "pairing": {
                "ticket": "clwpair1_demo",
                "phase": "waiting_for_confirm"
            },
            "updatedAt": "2026-03-29T00:00:00.000Z"
        }))
        .expect("serialize onboarding session"),
    )
    .expect("write onboarding session");

    let mut deliver = fixture_deliver_frame();
    apply_pair_accepted_system_delivery(
        &test_options(),
        "alpha",
        &store,
        temp.path(),
        &mut deliver,
    )
    .await
    .expect("apply");

    let raw = std::fs::read_to_string(temp.path().join("onboarding-session.json"))
        .expect("read onboarding session");
    let session: serde_json::Value = serde_json::from_str(&raw).expect("parse session");
    assert_eq!(
        session.get("state").and_then(Value::as_str),
        Some("messaging_ready")
    );
    assert_eq!(
        session
            .get("pairing")
            .and_then(|value| value.get("phase"))
            .and_then(Value::as_str),
        Some("peer_saved")
    );
    let peer_alias = session
        .get("pairing")
        .and_then(|value| value.get("peerAlias"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    assert!(!peer_alias.trim().is_empty());
    assert_eq!(
        session
            .get("pairing")
            .and_then(|value| value.get("ticket"))
            .and_then(Value::as_str),
        Some("clwpair1_demo")
    );
}

#[tokio::test]
async fn pair_accepted_does_not_fail_when_onboarding_session_is_invalid_json() {
    let temp = TempDir::new().expect("temp dir");
    let store =
        clawdentity_core::SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("open db");

    std::fs::write(temp.path().join("onboarding-session.json"), "{not-json")
        .expect("write invalid onboarding session");

    let mut deliver = fixture_deliver_frame();
    let handled = apply_pair_accepted_system_delivery(
        &test_options(),
        "alpha",
        &store,
        temp.path(),
        &mut deliver,
    )
    .await
    .expect("pair accepted should still succeed");
    assert!(handled);

    let peers = list_peers(&store).expect("list peers");
    assert_eq!(peers.len(), 1);
}

#[tokio::test]
async fn pair_accepted_persists_peer_when_registry_lookup_is_unavailable() {
    let temp = TempDir::new().expect("temp dir");
    let store =
        clawdentity_core::SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("open db");

    let mut deliver = fixture_deliver_frame();
    deliver.payload["system"]["responderProfile"]["agentName"] =
        json!(PAIR_ACCEPTED_TEST_OUTAGE_AGENT_NAME);
    deliver.payload["system"]["responderProfile"]["displayName"] = json!("Fallback Name");

    let handled = apply_pair_accepted_system_delivery(
        &test_options(),
        "alpha",
        &store,
        temp.path(),
        &mut deliver,
    )
    .await
    .expect("pair accepted should succeed with fallback profile");
    assert!(handled);

    let peers = list_peers(&store).expect("list peers");
    assert_eq!(peers.len(), 1);
    assert_eq!(
        peers[0].agent_name.as_deref(),
        Some(PAIR_ACCEPTED_TEST_OUTAGE_AGENT_NAME)
    );
    assert_eq!(peers[0].display_name.as_deref(), Some("Fallback Name"));
}

#[tokio::test]
async fn pair_accepted_does_not_override_non_pairing_onboarding_state() {
    let temp = TempDir::new().expect("temp dir");
    let store =
        clawdentity_core::SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("open db");

    std::fs::write(
        temp.path().join("onboarding-session.json"),
        serde_json::to_string_pretty(&json!({
            "version": 1,
            "state": "custom_terminal_state",
            "platform": "generic",
            "agentName": "alpha-local",
            "displayName": "Alpha Local",
            "pairing": {
                "ticket": "clwpair1_demo",
                "phase": "waiting_for_confirm"
            },
            "updatedAt": "2026-03-29T00:00:00.000Z"
        }))
        .expect("serialize onboarding session"),
    )
    .expect("write onboarding session");

    let mut deliver = fixture_deliver_frame();
    apply_pair_accepted_system_delivery(
        &test_options(),
        "alpha",
        &store,
        temp.path(),
        &mut deliver,
    )
    .await
    .expect("apply");

    let raw = std::fs::read_to_string(temp.path().join("onboarding-session.json"))
        .expect("read onboarding session");
    let session: serde_json::Value = serde_json::from_str(&raw).expect("parse session");
    assert_eq!(
        session.get("state").and_then(Value::as_str),
        Some("custom_terminal_state")
    );
    assert_eq!(
        session
            .get("pairing")
            .and_then(|value| value.get("phase"))
            .and_then(Value::as_str),
        Some("peer_saved")
    );
}
