use std::path::Path;

use anyhow::{Result, anyhow};
use chrono::{SecondsFormat, Utc};
use clawdentity_core::{
    DeliverFrame, PairProfile, SqliteStore, parse_agent_did,
    persist_confirmed_peer_from_profile_and_proxy_origin,
};
use serde::Deserialize;
use serde_json::{Value, json};

const PAIR_ACCEPTED_SYSTEM_EVENT_TYPE: &str = "pair.accepted";
const PAIR_ACCEPTED_TRUSTED_DELIVERY_SOURCE: &str = "proxy.events.queue.pair_accepted";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairAcceptedSystemProfile {
    agent_name: String,
    human_name: String,
    proxy_origin: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairAcceptedSystemEvent {
    #[serde(rename = "type")]
    event_type: String,
    initiator_agent_did: String,
    responder_agent_did: String,
    responder_profile: PairAcceptedSystemProfile,
    issuer_proxy_origin: String,
    event_timestamp_utc: String,
    message: Option<String>,
}

fn normalize_non_empty(value: &str, field: &str) -> Result<String> {
    let normalized = value.trim();
    if normalized.is_empty() {
        return Err(anyhow!("{field} is required"));
    }
    Ok(normalized.to_string())
}

fn normalize_proxy_origin(value: &str, field: &str) -> Result<String> {
    let normalized = normalize_non_empty(value, field)?;
    let parsed = reqwest::Url::parse(&normalized)
        .map_err(|_| anyhow!("{field} must be a valid http(s) URL origin"))?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err(anyhow!("{field} must be a valid http(s) URL origin"));
    }
    Ok(parsed.origin().unicode_serialization())
}

fn normalize_event_timestamp_utc(value: &str) -> Result<String> {
    let normalized = normalize_non_empty(value, "eventTimestampUtc")?;
    let parsed = chrono::DateTime::parse_from_rfc3339(&normalized)
        .map_err(|_| anyhow!("eventTimestampUtc must be a valid RFC3339 timestamp"))?;
    Ok(parsed
        .with_timezone(&Utc)
        .to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn normalize_optional_message(value: Option<&str>) -> Result<Option<String>> {
    value
        .map(|candidate| normalize_non_empty(candidate, "message"))
        .transpose()
}

fn normalize_pair_accepted_event(raw: PairAcceptedSystemEvent) -> Result<PairAcceptedSystemEvent> {
    if raw.event_type.trim() != PAIR_ACCEPTED_SYSTEM_EVENT_TYPE {
        return Err(anyhow!("unsupported pair.accepted system event type"));
    }

    let initiator_agent_did = normalize_non_empty(&raw.initiator_agent_did, "initiatorAgentDid")?;
    parse_agent_did(&initiator_agent_did)?;

    let responder_agent_did = normalize_non_empty(&raw.responder_agent_did, "responderAgentDid")?;
    parse_agent_did(&responder_agent_did)?;

    let responder_profile = PairAcceptedSystemProfile {
        agent_name: normalize_non_empty(
            &raw.responder_profile.agent_name,
            "responderProfile.agentName",
        )?,
        human_name: normalize_non_empty(
            &raw.responder_profile.human_name,
            "responderProfile.humanName",
        )?,
        proxy_origin: normalize_proxy_origin(
            &raw.responder_profile.proxy_origin,
            "responderProfile.proxyOrigin",
        )?,
    };

    let issuer_proxy_origin =
        normalize_proxy_origin(&raw.issuer_proxy_origin, "issuerProxyOrigin")?;
    let event_timestamp_utc = normalize_event_timestamp_utc(&raw.event_timestamp_utc)?;
    let message = normalize_optional_message(raw.message.as_deref())?;

    Ok(PairAcceptedSystemEvent {
        event_type: PAIR_ACCEPTED_SYSTEM_EVENT_TYPE.to_string(),
        initiator_agent_did,
        responder_agent_did,
        responder_profile,
        issuer_proxy_origin,
        event_timestamp_utc,
        message,
    })
}

fn parse_pair_accepted_system_event(payload: &Value) -> Result<Option<PairAcceptedSystemEvent>> {
    let Some(system_payload) = payload.get("system") else {
        return Ok(None);
    };
    if !system_payload.is_object() {
        return Ok(None);
    }

    let event_type = system_payload
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim);
    if event_type != Some(PAIR_ACCEPTED_SYSTEM_EVENT_TYPE) {
        return Ok(None);
    }

    let parsed = serde_json::from_value::<PairAcceptedSystemEvent>(system_payload.clone())
        .map_err(|error| anyhow!("pair.accepted system payload is invalid: {error}"))?;
    Ok(Some(normalize_pair_accepted_event(parsed)?))
}

fn build_notification_payload(event: &PairAcceptedSystemEvent, peer_alias: &str) -> Value {
    let message = event.message.clone().unwrap_or_else(|| {
        format!(
            "Clawdentity pairing accepted: {} ({}) is now saved as peer alias {}.",
            event.responder_profile.agent_name, event.responder_profile.human_name, peer_alias
        )
    });

    json!({
        "type": "clawdentity:pair-accepted",
        "event": PAIR_ACCEPTED_SYSTEM_EVENT_TYPE,
        "message": message,
        "peerAlias": peer_alias,
        "pairAccepted": {
            "initiatorAgentDid": event.initiator_agent_did,
            "responderAgentDid": event.responder_agent_did,
            "responderProfile": {
                "agentName": event.responder_profile.agent_name,
                "humanName": event.responder_profile.human_name,
                "proxyOrigin": event.responder_profile.proxy_origin,
            },
            "issuerProxyOrigin": event.issuer_proxy_origin,
            "eventTimestampUtc": event.event_timestamp_utc,
        },
    })
}

pub(super) fn apply_pair_accepted_system_delivery(
    store: &SqliteStore,
    config_dir: &Path,
    deliver: &mut DeliverFrame,
) -> Result<bool> {
    if !is_trusted_pair_accepted_delivery(deliver) {
        return Ok(false);
    }

    let Some(event) = parse_pair_accepted_system_event(&deliver.payload)? else {
        return Ok(false);
    };

    if deliver.to_agent_did.trim() != event.initiator_agent_did {
        return Err(anyhow!(
            "pair.accepted initiator DID does not match delivery recipient DID"
        ));
    }
    if deliver.from_agent_did.trim() != event.responder_agent_did {
        return Err(anyhow!(
            "pair.accepted responder DID does not match delivery sender DID"
        ));
    }

    let peer_alias = persist_confirmed_peer_from_profile_and_proxy_origin(
        store,
        config_dir,
        &event.responder_agent_did,
        &PairProfile {
            agent_name: event.responder_profile.agent_name.clone(),
            human_name: event.responder_profile.human_name.clone(),
            proxy_origin: Some(event.responder_profile.proxy_origin.clone()),
        },
        Some(event.responder_profile.proxy_origin.clone()),
    )?;

    deliver.payload = build_notification_payload(&event, &peer_alias);
    Ok(true)
}

pub(super) fn is_trusted_pair_accepted_delivery(deliver: &DeliverFrame) -> bool {
    deliver.delivery_source.as_deref() == Some(PAIR_ACCEPTED_TRUSTED_DELIVERY_SOURCE)
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use clawdentity_core::{list_peers, now_iso};
    use serde_json::json;

    use super::PAIR_ACCEPTED_TRUSTED_DELIVERY_SOURCE;
    use super::{apply_pair_accepted_system_delivery, is_trusted_pair_accepted_delivery};

    fn fixture_deliver_frame() -> clawdentity_core::DeliverFrame {
        clawdentity_core::DeliverFrame {
            v: clawdentity_core::CONNECTOR_FRAME_VERSION,
            id: "req-pair-accepted-1".to_string(),
            ts: now_iso(),
            from_agent_did: "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97"
                .to_string(),
            to_agent_did: "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7"
                .to_string(),
            payload: json!({
                "system": {
                    "type": "pair.accepted",
                    "initiatorAgentDid": "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
                    "responderAgentDid": "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
                    "responderProfile": {
                        "agentName": "beta",
                        "humanName": "Ira",
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

    fn write_runtime_snapshot_config(
        config_dir: &std::path::Path,
        snapshot_path: &std::path::Path,
    ) {
        std::fs::write(
            config_dir.join("openclaw-relay.json"),
            format!(
                "{{\"relayTransformPeersPath\":\"{}\"}}",
                snapshot_path.display()
            ),
        )
        .expect("write relay runtime config");
    }

    #[test]
    fn pair_accepted_event_persists_peer_and_updates_notification_payload() {
        let temp = TempDir::new().expect("temp dir");
        let store = clawdentity_core::SqliteStore::open_path(temp.path().join("db.sqlite3"))
            .expect("open db");
        let snapshot_path = temp.path().join("relay-peers.json");
        write_runtime_snapshot_config(temp.path(), &snapshot_path);

        let mut deliver = fixture_deliver_frame();
        let handled = apply_pair_accepted_system_delivery(&store, temp.path(), &mut deliver)
            .expect("apply pair accepted delivery");
        assert!(handled);

        let peers = list_peers(&store).expect("list peers");
        assert_eq!(peers.len(), 1);
        assert_eq!(
            peers[0].did,
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97"
        );
        assert!(snapshot_path.exists());

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

    #[test]
    fn duplicate_pair_accepted_events_are_idempotent_for_peer_state() {
        let temp = TempDir::new().expect("temp dir");
        let store = clawdentity_core::SqliteStore::open_path(temp.path().join("db.sqlite3"))
            .expect("open db");
        let snapshot_path = temp.path().join("relay-peers.json");
        write_runtime_snapshot_config(temp.path(), &snapshot_path);

        let mut first = fixture_deliver_frame();
        apply_pair_accepted_system_delivery(&store, temp.path(), &mut first).expect("first apply");

        let mut second = fixture_deliver_frame();
        apply_pair_accepted_system_delivery(&store, temp.path(), &mut second)
            .expect("second apply");

        let peers = list_peers(&store).expect("list peers");
        assert_eq!(peers.len(), 1);
    }

    #[test]
    fn non_system_payload_is_ignored() {
        let temp = TempDir::new().expect("temp dir");
        let store = clawdentity_core::SqliteStore::open_path(temp.path().join("db.sqlite3"))
            .expect("open db");
        let mut deliver = fixture_deliver_frame();
        deliver.payload = json!({ "message": "hello" });

        let handled =
            apply_pair_accepted_system_delivery(&store, temp.path(), &mut deliver).expect("apply");
        assert!(!handled);
    }

    #[test]
    fn pair_accepted_is_ignored_when_delivery_source_is_not_trusted() {
        let temp = TempDir::new().expect("temp dir");
        let store = clawdentity_core::SqliteStore::open_path(temp.path().join("db.sqlite3"))
            .expect("open db");
        let mut deliver = fixture_deliver_frame();
        deliver.delivery_source = Some("agent.enqueue".to_string());

        let handled =
            apply_pair_accepted_system_delivery(&store, temp.path(), &mut deliver).expect("apply");
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

    #[test]
    fn pair_accepted_event_normalizes_timestamp_to_utc_rfc3339() {
        let temp = TempDir::new().expect("temp dir");
        let store = clawdentity_core::SqliteStore::open_path(temp.path().join("db.sqlite3"))
            .expect("open db");
        let snapshot_path = temp.path().join("relay-peers.json");
        write_runtime_snapshot_config(temp.path(), &snapshot_path);

        let mut deliver = fixture_deliver_frame();
        deliver.payload["system"]["eventTimestampUtc"] = json!("2026-03-28T05:30:00.000+05:30");

        apply_pair_accepted_system_delivery(&store, temp.path(), &mut deliver).expect("apply");

        assert_eq!(
            deliver
                .payload
                .get("pairAccepted")
                .and_then(|value| value.get("eventTimestampUtc"))
                .and_then(serde_json::Value::as_str),
            Some("2026-03-28T00:00:00.000Z")
        );
    }

    #[test]
    fn pair_accepted_notification_prefers_proxy_message_when_present() {
        let temp = TempDir::new().expect("temp dir");
        let store = clawdentity_core::SqliteStore::open_path(temp.path().join("db.sqlite3"))
            .expect("open db");
        let snapshot_path = temp.path().join("relay-peers.json");
        write_runtime_snapshot_config(temp.path(), &snapshot_path);

        let mut deliver = fixture_deliver_frame();
        deliver.payload["system"]["message"] =
            json!("Clawdentity pairing complete. You can now message this peer.");

        apply_pair_accepted_system_delivery(&store, temp.path(), &mut deliver).expect("apply");

        assert_eq!(
            deliver
                .payload
                .get("message")
                .and_then(serde_json::Value::as_str),
            Some("Clawdentity pairing complete. You can now message this peer.")
        );
    }

    #[test]
    fn pair_accepted_rejects_blank_proxy_message() {
        let temp = TempDir::new().expect("temp dir");
        let store = clawdentity_core::SqliteStore::open_path(temp.path().join("db.sqlite3"))
            .expect("open db");
        let snapshot_path = temp.path().join("relay-peers.json");
        write_runtime_snapshot_config(temp.path(), &snapshot_path);

        let mut deliver = fixture_deliver_frame();
        deliver.payload["system"]["message"] = json!("   ");

        let error = apply_pair_accepted_system_delivery(&store, temp.path(), &mut deliver)
            .expect_err("blank message should fail validation");
        assert!(error.to_string().contains("message is required"));
    }
}
