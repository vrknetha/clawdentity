use super::*;

#[test]
fn openclaw_wake_payload_headline_prefers_friendly_names() {
    let deliver = DeliverFrame {
        v: 1,
        id: "req-5c".to_string(),
        ts: "2026-03-20T05:55:00Z".to_string(),
        from_agent_did: "did:cdi:test:agent:sender".to_string(),
        to_agent_did: "did:cdi:test:agent:recipient".to_string(),
        group_id: Some("grp_01J0W8B6M7VWWC0H8G8D2MPH6V".to_string()),
        payload: json!({
            "message": "wake test",
        }),
        delivery_source: None,
        content_type: Some("application/json".to_string()),
        conversation_id: None,
        reply_to: None,
    };
    let sender_profile = SenderProfileHeaders {
        agent_name: Some("alpha".to_string()),
        display_name: Some("Ravi".to_string()),
    };

    let payload = build_openclaw_hook_payload(
        "/hooks/wake",
        &deliver,
        Some(&sender_profile),
        Some("research-crew"),
        None,
    );
    let text = payload
        .get("text")
        .and_then(|value| value.as_str())
        .expect("wake text");
    assert!(text.starts_with("Message in research-crew from alpha (Ravi)"));
}

#[test]
fn openclaw_agent_payload_ignores_sender_supplied_name_metadata() {
    let deliver = DeliverFrame {
        v: 1,
        id: "req-5d".to_string(),
        ts: "2026-03-20T05:55:00Z".to_string(),
        from_agent_did: "did:cdi:test:agent:sender".to_string(),
        to_agent_did: "did:cdi:test:agent:recipient".to_string(),
        group_id: None,
        payload: json!({
            "message": "hello",
            "senderAgentName": "spoofed-agent",
            "senderDisplayName": "Spoofed Human"
        }),
        delivery_source: None,
        content_type: Some("application/json".to_string()),
        conversation_id: None,
        reply_to: None,
    };

    let payload = build_openclaw_hook_payload("/hooks/agent", &deliver, None, None, None);
    assert!(
        payload
            .get("senderAgentName")
            .is_some_and(|value| value.is_null())
    );
    assert!(
        payload
            .get("senderDisplayName")
            .is_some_and(|value| value.is_null())
    );
}

#[test]
fn openclaw_agent_payload_keeps_group_name_missing_when_unresolved() {
    let deliver = DeliverFrame {
        v: 1,
        id: "req-5e".to_string(),
        ts: "2026-03-20T05:55:00Z".to_string(),
        from_agent_did: "did:cdi:test:agent:sender".to_string(),
        to_agent_did: "did:cdi:test:agent:recipient".to_string(),
        group_id: Some("grp_01J0W8B6M7VWWC0H8G8D2MPH6V".to_string()),
        payload: json!({
            "message": "hello",
            "groupName": "spoofed-group"
        }),
        delivery_source: None,
        content_type: Some("application/json".to_string()),
        conversation_id: None,
        reply_to: None,
    };

    let payload = build_openclaw_hook_payload("/hooks/agent", &deliver, None, None, None);
    assert_eq!(
        payload.get("groupId").and_then(|value| value.as_str()),
        Some("grp_01J0W8B6M7VWWC0H8G8D2MPH6V")
    );
    assert!(
        payload
            .get("groupName")
            .is_some_and(|value| value.is_null())
    );
}

#[tokio::test]
async fn inbound_sender_profile_uses_local_metadata_when_fresh() {
    let (options, agent_name) = setup_receipt_header_fixture();
    let store = SqliteStore::open(&options).expect("open sqlite store");
    let sender_did = "did:cdi:registry.example:agent:01J0X2R4Q05B8MR6ZWYWVFQ3JW";
    upsert_peer(
        &store,
        UpsertPeerInput {
            alias: "beta".to_string(),
            did: sender_did.to_string(),
            proxy_url: "https://proxy.example/hooks/agent".to_string(),
            agent_name: Some("beta".to_string()),
            display_name: Some("Ira".to_string()),
            framework: Some("openclaw".to_string()),
            description: None,
            last_synced_at_ms: Some(now_utc_ms()),
        },
    )
    .expect("upsert peer");

    let profile =
        resolve_sender_profile_for_delivery(&options, &agent_name, &store, sender_did).await;
    assert_eq!(
        profile.and_then(|value| value.agent_name),
        Some("beta".to_string())
    );
}

#[tokio::test]
async fn inbound_sender_profile_refreshes_from_registry_when_local_metadata_missing() {
    let server = MockServer::start().await;
    let sender_did = "did:cdi:registry.example:agent:01J0X2R4Q05B8MR6ZWYWVFQ3JX";
    Mock::given(method("GET"))
        .and(path("/v1/agents/profile"))
        .and(query_param("did", sender_did))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "agentDid": sender_did,
            "agentName": "beta",
            "displayName": "Ira",
            "framework": "openclaw",
            "status": "active",
            "humanDid": "did:cdi:registry.example:human:01J0X2R4Q05B8MR6ZWYWVFQ3JX"
        })))
        .expect(1)
        .mount(&server)
        .await;

    let (options, agent_name) = setup_receipt_header_fixture_with_registry(&server.uri());
    let store = SqliteStore::open(&options).expect("open sqlite store");
    let stale_sync = now_utc_ms() - 120_000;
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
            last_synced_at_ms: Some(stale_sync),
        },
    )
    .expect("upsert peer");

    let profile =
        resolve_sender_profile_for_delivery(&options, &agent_name, &store, sender_did).await;
    let profile = profile.expect("resolved profile");
    assert_eq!(profile.agent_name.as_deref(), Some("beta"));
    assert_eq!(profile.display_name.as_deref(), Some("Ira"));

    let persisted = get_peer_by_did(&store, sender_did)
        .expect("get peer by did")
        .expect("peer persisted");
    assert_eq!(persisted.agent_name.as_deref(), Some("beta"));
    assert_eq!(persisted.display_name.as_deref(), Some("Ira"));
    assert!(persisted.last_synced_at_ms.unwrap_or_default() > stale_sync);
}

#[tokio::test]
async fn inbound_sender_profile_falls_back_to_local_metadata_when_registry_refresh_fails() {
    let server = MockServer::start().await;
    let sender_did = "did:cdi:registry.example:agent:01J0X2R4Q05B8MR6ZWYWVFQ3JY";
    Mock::given(method("GET"))
        .and(path("/v1/agents/profile"))
        .and(query_param("did", sender_did))
        .respond_with(ResponseTemplate::new(503))
        .expect(1)
        .mount(&server)
        .await;

    let (options, agent_name) = setup_receipt_header_fixture_with_registry(&server.uri());
    let store = SqliteStore::open(&options).expect("open sqlite store");
    upsert_peer(
        &store,
        UpsertPeerInput {
            alias: "beta".to_string(),
            did: sender_did.to_string(),
            proxy_url: "https://proxy.example/hooks/agent".to_string(),
            agent_name: Some("beta-local".to_string()),
            display_name: Some("Ira Local".to_string()),
            framework: Some("openclaw".to_string()),
            description: None,
            last_synced_at_ms: Some(now_utc_ms() - 120_000),
        },
    )
    .expect("upsert peer");

    let profile =
        resolve_sender_profile_for_delivery(&options, &agent_name, &store, sender_did).await;
    let profile = profile.expect("resolved profile");
    assert_eq!(profile.agent_name.as_deref(), Some("beta-local"));
    assert_eq!(profile.display_name.as_deref(), Some("Ira Local"));
}

#[tokio::test]
async fn inbound_sender_profile_uses_short_lived_cache_after_registry_refresh() {
    let server = MockServer::start().await;
    let sender_did = "did:cdi:registry.example:agent:01J0X2R4Q05B8MR6ZWYWVFQ3JZ";
    Mock::given(method("GET"))
        .and(path("/v1/agents/profile"))
        .and(query_param("did", sender_did))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "agentDid": sender_did,
            "agentName": "beta",
            "displayName": "Ira",
            "framework": "openclaw",
            "status": "active",
            "humanDid": "did:cdi:registry.example:human:01J0X2R4Q05B8MR6ZWYWVFQ3JZ"
        })))
        .expect(1)
        .mount(&server)
        .await;

    let (options, agent_name) = setup_receipt_header_fixture_with_registry(&server.uri());
    let store = SqliteStore::open(&options).expect("open sqlite store");

    let first =
        resolve_sender_profile_for_delivery(&options, &agent_name, &store, sender_did).await;
    let second =
        resolve_sender_profile_for_delivery(&options, &agent_name, &store, sender_did).await;
    assert_eq!(
        first.and_then(|value| value.agent_name),
        Some("beta".to_string())
    );
    assert_eq!(
        second.and_then(|value| value.agent_name),
        Some("beta".to_string())
    );
}

#[tokio::test]
async fn inbound_group_name_resolution_uses_registry_and_cache() {
    let server = MockServer::start().await;
    let group_id = "grp_01J0X2R4Q05B8MR6ZWYWVFQ3JW";
    Mock::given(method("GET"))
        .and(path(format!("/v1/groups/{group_id}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "group": { "name": "research-crew" }
        })))
        .expect(1)
        .mount(&server)
        .await;

    let (options, agent_name) = setup_receipt_header_fixture_with_registry(&server.uri());
    let first = resolve_group_name_for_delivery(&options, &agent_name, Some(group_id)).await;
    let second = resolve_group_name_for_delivery(&options, &agent_name, Some(group_id)).await;

    assert_eq!(first.as_deref(), Some("research-crew"));
    assert_eq!(second.as_deref(), Some("research-crew"));
}

#[tokio::test]
async fn inbound_group_name_resolution_returns_none_when_lookup_fails() {
    let server = MockServer::start().await;
    let group_id = "grp_01J0X2R4Q05B8MR6ZWYWVFQ3JX";
    Mock::given(method("GET"))
        .and(path(format!("/v1/groups/{group_id}")))
        .respond_with(ResponseTemplate::new(503))
        .expect(1)
        .mount(&server)
        .await;

    let (options, agent_name) = setup_receipt_header_fixture_with_registry(&server.uri());
    let group_name = resolve_group_name_for_delivery(&options, &agent_name, Some(group_id)).await;
    assert!(group_name.is_none());
}
