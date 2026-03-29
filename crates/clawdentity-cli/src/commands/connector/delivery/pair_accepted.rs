use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use anyhow::{Result, anyhow};
use chrono::{SecondsFormat, Utc};
use clawdentity_core::{
    DeliverFrame, PairProfile, SqliteStore, parse_agent_did,
    persist_confirmed_peer_from_profile_and_proxy_origin,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use tracing::warn;

const PAIR_ACCEPTED_SYSTEM_EVENT_TYPE: &str = "pair.accepted";
const PAIR_ACCEPTED_TRUSTED_DELIVERY_SOURCE: &str = "proxy.events.queue.pair_accepted";
const ONBOARDING_SESSION_FILE_NAME: &str = "onboarding-session.json";
// Serialized `OnboardingState` / `PairingProgressState` values are snake_case.
const ONBOARDING_STATE_PAIRING_PENDING: &str = "pairing_pending";
const ONBOARDING_STATE_PAIRED: &str = "paired";
const ONBOARDING_STATE_MESSAGING_READY: &str = "messaging_ready";
const ONBOARDING_PAIRING_PHASE_PEER_SAVED: &str = "peer_saved";

fn read_onboarding_session(path: &Path) -> Result<Option<Value>> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(anyhow!(
                "failed to read onboarding session {}: {error}",
                path.display()
            ));
        }
    };

    if raw.trim().is_empty() {
        return Ok(None);
    }

    let session = serde_json::from_str::<Value>(&raw).map_err(|error| {
        anyhow!(
            "failed to parse onboarding session {}: {error}",
            path.display()
        )
    })?;
    Ok(Some(session))
}

fn should_promote_onboarding_state(current_state: Option<&str>) -> bool {
    matches!(
        current_state,
        None | Some(ONBOARDING_STATE_PAIRING_PENDING) | Some(ONBOARDING_STATE_PAIRED)
    )
}

fn reconcile_onboarding_session_object(session_object: &mut Map<String, Value>, peer_alias: &str) {
    if should_promote_onboarding_state(session_object.get("state").and_then(Value::as_str)) {
        session_object.insert("state".to_string(), json!(ONBOARDING_STATE_MESSAGING_READY));
    }
    session_object.insert("updatedAt".to_string(), json!(clawdentity_core::now_iso()));

    let pairing = session_object.entry("pairing").or_insert_with(|| json!({}));
    if !pairing.is_object() {
        *pairing = json!({});
    }

    if let Some(pairing_object) = pairing.as_object_mut() {
        pairing_object.insert("peerAlias".to_string(), json!(peer_alias));
        pairing_object.insert(
            "phase".to_string(),
            json!(ONBOARDING_PAIRING_PHASE_PEER_SAVED),
        );
    }
}

fn write_onboarding_session(path: &Path, session: &Value) -> Result<()> {
    let payload = format!("{}\n", serde_json::to_string_pretty(session)?);
    fs::write(path, payload).map_err(|error| {
        anyhow!(
            "failed to write onboarding session {}: {error}",
            path.display()
        )
    })?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = fs::Permissions::from_mode(0o600);
        fs::set_permissions(path, permissions).map_err(|error| {
            anyhow!(
                "failed to set onboarding session permissions {}: {error}",
                path.display()
            )
        })?;
    }

    Ok(())
}

fn reconcile_onboarding_session_pairing_state(config_dir: &Path, peer_alias: &str) -> Result<()> {
    let path = config_dir.join(ONBOARDING_SESSION_FILE_NAME);
    let Some(mut session) = read_onboarding_session(&path)? else {
        return Ok(());
    };
    let session_object = session
        .as_object_mut()
        .ok_or_else(|| anyhow!("onboarding session {} is not an object", path.display()))?;
    reconcile_onboarding_session_object(session_object, peer_alias);
    write_onboarding_session(&path, &session)
}

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
    Ok(value
        .map(str::trim)
        .filter(|candidate| !candidate.is_empty())
        .map(|candidate| candidate.to_string()))
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

    if let Err(error) = reconcile_onboarding_session_pairing_state(config_dir, &peer_alias) {
        warn!(
            error = %error,
            path = %config_dir.join(ONBOARDING_SESSION_FILE_NAME).display(),
            "failed to reconcile onboarding session after trusted pair.accepted delivery"
        );
    }

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
    use serde_json::{Value, json};

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
    fn pair_accepted_ignores_blank_proxy_message_and_uses_fallback() {
        let temp = TempDir::new().expect("temp dir");
        let store = clawdentity_core::SqliteStore::open_path(temp.path().join("db.sqlite3"))
            .expect("open db");
        let snapshot_path = temp.path().join("relay-peers.json");
        write_runtime_snapshot_config(temp.path(), &snapshot_path);

        let mut deliver = fixture_deliver_frame();
        deliver.payload["system"]["message"] = json!("   ");

        apply_pair_accepted_system_delivery(&store, temp.path(), &mut deliver).expect("apply");

        let message = deliver
            .payload
            .get("message")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        assert!(message.contains("Clawdentity pairing accepted"));
    }

    #[test]
    fn pair_accepted_updates_stale_onboarding_session_to_messaging_ready() {
        let temp = TempDir::new().expect("temp dir");
        let store = clawdentity_core::SqliteStore::open_path(temp.path().join("db.sqlite3"))
            .expect("open db");
        let snapshot_path = temp.path().join("relay-peers.json");
        write_runtime_snapshot_config(temp.path(), &snapshot_path);

        std::fs::write(
            temp.path().join("onboarding-session.json"),
            serde_json::to_string_pretty(&json!({
                "version": 1,
                "state": "pairing_pending",
                "platform": "openclaw",
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
        apply_pair_accepted_system_delivery(&store, temp.path(), &mut deliver).expect("apply");

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

    #[test]
    fn pair_accepted_does_not_fail_when_onboarding_session_is_invalid_json() {
        let temp = TempDir::new().expect("temp dir");
        let store = clawdentity_core::SqliteStore::open_path(temp.path().join("db.sqlite3"))
            .expect("open db");
        let snapshot_path = temp.path().join("relay-peers.json");
        write_runtime_snapshot_config(temp.path(), &snapshot_path);

        std::fs::write(temp.path().join("onboarding-session.json"), "{not-json")
            .expect("write invalid onboarding session");

        let mut deliver = fixture_deliver_frame();
        let handled = apply_pair_accepted_system_delivery(&store, temp.path(), &mut deliver)
            .expect("pair accepted should still succeed");
        assert!(handled);

        let peers = list_peers(&store).expect("list peers");
        assert_eq!(peers.len(), 1);
    }

    #[test]
    fn pair_accepted_does_not_override_non_pairing_onboarding_state() {
        let temp = TempDir::new().expect("temp dir");
        let store = clawdentity_core::SqliteStore::open_path(temp.path().join("db.sqlite3"))
            .expect("open db");
        let snapshot_path = temp.path().join("relay-peers.json");
        write_runtime_snapshot_config(temp.path(), &snapshot_path);

        std::fs::write(
            temp.path().join("onboarding-session.json"),
            serde_json::to_string_pretty(&json!({
                "version": 1,
                "state": "custom_terminal_state",
                "platform": "openclaw",
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
        apply_pair_accepted_system_delivery(&store, temp.path(), &mut deliver).expect("apply");

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
}
