use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use anyhow::{Result, anyhow};
use chrono::{SecondsFormat, Utc};
use clawdentity_core::{
    ConfigPathOptions, DeliverFrame, PairProfile, SqliteStore, UpsertPeerInput, get_peer_by_alias,
    now_utc_ms, parse_agent_did, persist_confirmed_peer_from_profile_and_proxy_origin, upsert_peer,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use tracing::warn;

use super::super::runtime_config::{RegistryAgentProfile, fetch_registry_agent_profile};

const PAIR_ACCEPTED_SYSTEM_EVENT_TYPE: &str = "pair.accepted";
const PAIR_ACCEPTED_TRUSTED_DELIVERY_SOURCE: &str = "proxy.events.queue.pair_accepted";
const PAIR_ACCEPTED_TEST_OUTAGE_AGENT_NAME: &str = "__simulate_registry_outage__";
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
    display_name: String,
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
        display_name: normalize_non_empty(
            &raw.responder_profile.display_name,
            "responderProfile.displayName",
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
            event.responder_profile.agent_name, event.responder_profile.display_name, peer_alias
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
                "displayName": event.responder_profile.display_name,
                "proxyOrigin": event.responder_profile.proxy_origin,
            },
            "issuerProxyOrigin": event.issuer_proxy_origin,
            "eventTimestampUtc": event.event_timestamp_utc,
        },
    })
}

#[allow(clippy::too_many_lines)]
pub(super) async fn apply_pair_accepted_system_delivery(
    options: &ConfigPathOptions,
    local_agent_name: &str,
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
            human_name: event.responder_profile.display_name.clone(),
            proxy_origin: Some(event.responder_profile.proxy_origin.clone()),
        },
        Some(event.responder_profile.proxy_origin.clone()),
    )?;

    match fetch_registry_profile(options, local_agent_name, &event).await {
        Ok(registry_profile) => {
            persist_canonical_peer_profile(store, &peer_alias, &registry_profile)?;
        }
        Err(error) => {
            warn!(
                error = %error,
                peer_alias = %peer_alias,
                responder_agent_did = %event.responder_agent_did,
                "pair.accepted registry profile enrichment failed; using responder profile fallback"
            );
        }
    }

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

async fn fetch_registry_profile(
    options: &ConfigPathOptions,
    local_agent_name: &str,
    event: &PairAcceptedSystemEvent,
) -> Result<RegistryAgentProfile> {
    let profile = if cfg!(test) {
        if event.responder_profile.agent_name == PAIR_ACCEPTED_TEST_OUTAGE_AGENT_NAME {
            return Err(anyhow!(
                "simulated registry profile lookup outage for pair.accepted test"
            ));
        }
        let _ = (options, local_agent_name);
        RegistryAgentProfile {
            agent_did: event.responder_agent_did.clone(),
            agent_name: event.responder_profile.agent_name.clone(),
            display_name: event.responder_profile.display_name.clone(),
            framework: Some("openclaw".to_string()),
            status: "active".to_string(),
            human_did: "did:cdi:registry.clawdentity.dev:human:01HF7YAT31JZHSMW1CG6Q6MHB7"
                .to_string(),
        }
    } else {
        fetch_registry_agent_profile(options, local_agent_name, &event.responder_agent_did).await?
    };
    if profile.agent_did != event.responder_agent_did {
        return Err(anyhow!("registry profile DID does not match responder DID"));
    }
    Ok(profile)
}

fn persist_canonical_peer_profile(
    store: &SqliteStore,
    peer_alias: &str,
    profile: &RegistryAgentProfile,
) -> Result<()> {
    let existing = get_peer_by_alias(store, peer_alias)?
        .ok_or_else(|| anyhow!("persisted peer alias was not found after pair.accepted"))?;
    upsert_peer(
        store,
        UpsertPeerInput {
            alias: existing.alias,
            did: existing.did,
            proxy_url: existing.proxy_url,
            agent_name: Some(profile.agent_name.clone()),
            display_name: Some(profile.display_name.clone()),
            framework: profile.framework.clone(),
            description: None,
            last_synced_at_ms: Some(now_utc_ms()),
        },
    )?;
    Ok(())
}

pub(super) fn is_trusted_pair_accepted_delivery(deliver: &DeliverFrame) -> bool {
    deliver.delivery_source.as_deref() == Some(PAIR_ACCEPTED_TRUSTED_DELIVERY_SOURCE)
}


#[cfg(test)]
mod tests;
