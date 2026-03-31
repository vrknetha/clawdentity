use std::time::Duration;

use super::*;

#[tokio::test]
async fn peer_refresh_stops_quickly_when_shutdown_is_requested() {
    let server = MockServer::start().await;
    let sender_did = "did:cdi:registry.example:agent:01J0X2R4Q05B8MR6ZWYWVFQ4AA";
    Mock::given(method("GET"))
        .and(path("/v1/agents/profile"))
        .and(query_param("did", sender_did))
        .respond_with(
            ResponseTemplate::new(200)
                .set_delay(Duration::from_secs(5))
                .set_body_json(json!({
                    "agentDid": sender_did,
                    "agentName": "beta",
                    "displayName": "Ira",
                    "framework": "openclaw",
                    "status": "active",
                    "humanDid": "did:cdi:registry.example:human:01J0X2R4Q05B8MR6ZWYWVFQ4AA"
                })),
        )
        .mount(&server)
        .await;

    let (options, agent_name) = setup_receipt_header_fixture_with_registry(&server.uri());
    let config_dir = get_config_dir(&options).expect("resolve config dir");
    let store = SqliteStore::open(&options).expect("open sqlite store");
    upsert_peer(
        &store,
        UpsertPeerInput {
            alias: "beta".to_string(),
            did: sender_did.to_string(),
            proxy_url: "https://proxy.example/hooks/agent".to_string(),
            agent_name: None,
            display_name: None,
            framework: Some("openclaw".to_string()),
            description: None,
            last_synced_at_ms: Some(now_utc_ms() - 120_000),
        },
    )
    .expect("upsert peer");

    let (shutdown_tx, mut shutdown_rx) = tokio::sync::watch::channel(false);
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        let _ = shutdown_tx.send(true);
    });

    let stopped = tokio::time::timeout(
        Duration::from_secs(1),
        super::super::refresh_peer_profiles_once(
            &options,
            &agent_name,
            config_dir.as_path(),
            &store,
            &mut shutdown_rx,
        ),
    )
    .await
    .expect("refresh should stop quickly after shutdown");

    assert!(stopped);
}
