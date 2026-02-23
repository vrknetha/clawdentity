use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use getrandom::fill as getrandom_fill;
use serde::{Deserialize, Serialize};

use crate::constants::{AGENTS_DIR, AIT_FILE_NAME, SECRET_KEY_FILE_NAME};
use crate::db::SqliteStore;
use crate::did::{ClawDidKind, parse_did};
use crate::error::{CoreError, Result};
use crate::http::blocking_client;
use crate::identity::decode_secret_key;
use crate::peers::{
    PersistPeerInput, load_peers_config, persist_peer, sync_openclaw_relay_peers_snapshot,
};
use crate::qr::decode_ticket_from_png;
use crate::signing::{SignHttpRequestInput, sign_http_request};

pub const PAIR_START_PATH: &str = "/pair/start";
pub const PAIR_CONFIRM_PATH: &str = "/pair/confirm";
pub const PAIR_STATUS_PATH: &str = "/pair/status";
pub const PAIRING_TICKET_PREFIX: &str = "clwpair1_";

pub const DEFAULT_STATUS_WAIT_SECONDS: u64 = 300;
pub const DEFAULT_STATUS_POLL_INTERVAL_SECONDS: u64 = 3;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairProfile {
    pub agent_name: String,
    pub human_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy_origin: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairStartResult {
    pub initiator_agent_did: String,
    pub initiator_profile: PairProfile,
    pub ticket: String,
    pub expires_at: String,
    pub proxy_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qr_path: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairConfirmResult {
    pub paired: bool,
    pub initiator_agent_did: String,
    pub initiator_profile: PairProfile,
    pub responder_agent_did: String,
    pub responder_profile: PairProfile,
    pub proxy_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peer_alias: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PairStatusKind {
    Pending,
    Confirmed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairStatusResult {
    pub status: PairStatusKind,
    pub initiator_agent_did: String,
    pub initiator_profile: PairProfile,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub responder_agent_did: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub responder_profile: Option<PairProfile>,
    pub expires_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirmed_at: Option<String>,
    pub proxy_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peer_alias: Option<String>,
}

#[derive(Debug, Clone)]
pub enum PairConfirmInput {
    Ticket(String),
    QrFile(PathBuf),
}

#[derive(Debug, Clone)]
pub struct PairStatusOptions {
    pub wait: bool,
    pub wait_seconds: u64,
    pub poll_interval_seconds: u64,
}

impl Default for PairStatusOptions {
    fn default() -> Self {
        Self {
            wait: false,
            wait_seconds: DEFAULT_STATUS_WAIT_SECONDS,
            poll_interval_seconds: DEFAULT_STATUS_POLL_INTERVAL_SECONDS,
        }
    }
}

#[derive(Debug, Clone)]
struct LocalAgentProofMaterial {
    ait: String,
    secret_key: ed25519_dalek::SigningKey,
    agent_did: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairStartResponsePayload {
    ticket: String,
    initiator_agent_did: String,
    initiator_profile: PairProfile,
    expires_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairConfirmResponsePayload {
    paired: bool,
    initiator_agent_did: String,
    initiator_profile: PairProfile,
    responder_agent_did: String,
    responder_profile: PairProfile,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairStatusResponsePayload {
    status: String,
    initiator_agent_did: String,
    initiator_profile: PairProfile,
    responder_agent_did: Option<String>,
    responder_profile: Option<PairProfile>,
    expires_at: String,
    confirmed_at: Option<String>,
}

fn parse_non_empty(value: &str, field: &str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(CoreError::InvalidInput(format!("{field} is required")));
    }
    Ok(trimmed.to_string())
}

fn parse_proxy_url(candidate: &str) -> Result<String> {
    let parsed = url::Url::parse(candidate)
        .map_err(|_| CoreError::InvalidInput("proxyUrl is invalid".to_string()))?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err(CoreError::InvalidInput("proxyUrl is invalid".to_string()));
    }
    Ok(parsed.to_string())
}

fn parse_pair_profile(profile: &PairProfile) -> Result<PairProfile> {
    Ok(PairProfile {
        agent_name: parse_non_empty(&profile.agent_name, "agentName")?,
        human_name: parse_non_empty(&profile.human_name, "humanName")?,
        proxy_origin: profile
            .proxy_origin
            .as_deref()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
    })
}

pub fn parse_pairing_ticket(value: &str) -> Result<String> {
    let mut ticket = value.trim().trim_matches('`').to_string();
    ticket.retain(|character| !character.is_whitespace());
    if !ticket.starts_with(PAIRING_TICKET_PREFIX) {
        return Err(CoreError::InvalidInput(
            "pairing ticket is invalid".to_string(),
        ));
    }

    let encoded_payload = &ticket[PAIRING_TICKET_PREFIX.len()..];
    if encoded_payload.is_empty() {
        return Err(CoreError::InvalidInput(
            "pairing ticket is invalid".to_string(),
        ));
    }

    let payload_raw = URL_SAFE_NO_PAD
        .decode(encoded_payload)
        .map_err(|_| CoreError::InvalidInput("pairing ticket is invalid".to_string()))?;
    let payload_json = std::str::from_utf8(&payload_raw)
        .map_err(|_| CoreError::InvalidInput("pairing ticket is invalid".to_string()))?;
    let _: serde_json::Value = serde_json::from_str(payload_json)
        .map_err(|_| CoreError::InvalidInput("pairing ticket is invalid".to_string()))?;

    Ok(ticket)
}

pub fn parse_pairing_ticket_issuer_origin(ticket: &str) -> Result<String> {
    let ticket = parse_pairing_ticket(ticket)?;
    let encoded_payload = &ticket[PAIRING_TICKET_PREFIX.len()..];
    let payload_raw = URL_SAFE_NO_PAD
        .decode(encoded_payload)
        .map_err(|_| CoreError::InvalidInput("pairing ticket is invalid".to_string()))?;
    let payload: serde_json::Value = serde_json::from_slice(&payload_raw)
        .map_err(|_| CoreError::InvalidInput("pairing ticket is invalid".to_string()))?;
    let issuer = payload
        .get("iss")
        .and_then(|value| value.as_str())
        .ok_or_else(|| CoreError::InvalidInput("pairing ticket is invalid".to_string()))?;
    let issuer_url = url::Url::parse(issuer)
        .map_err(|_| CoreError::InvalidInput("pairing ticket is invalid".to_string()))?;
    if issuer_url.scheme() != "https" && issuer_url.scheme() != "http" {
        return Err(CoreError::InvalidInput(
            "pairing ticket is invalid".to_string(),
        ));
    }
    Ok(issuer_url.origin().unicode_serialization())
}

pub fn assert_ticket_issuer_matches_proxy(ticket: &str, proxy_url: &str) -> Result<()> {
    let issuer_origin = parse_pairing_ticket_issuer_origin(ticket)?;
    let proxy_origin = url::Url::parse(proxy_url)
        .map_err(|_| CoreError::InvalidInput("proxyUrl is invalid".to_string()))?
        .origin()
        .unicode_serialization();
    if issuer_origin != proxy_origin {
        return Err(CoreError::InvalidInput(format!(
            "pairing ticket issuer {issuer_origin} does not match proxy origin {proxy_origin}"
        )));
    }
    Ok(())
}

fn read_local_agent_proof_material(
    config_dir: &Path,
    agent_name: &str,
) -> Result<LocalAgentProofMaterial> {
    let normalized_agent_name = parse_non_empty(agent_name, "agentName")?;
    let agent_dir = config_dir.join(AGENTS_DIR).join(normalized_agent_name);
    let ait_path = agent_dir.join(AIT_FILE_NAME);
    let secret_key_path = agent_dir.join(SECRET_KEY_FILE_NAME);

    let ait = fs::read_to_string(&ait_path).map_err(|source| CoreError::Io {
        path: ait_path.clone(),
        source,
    })?;
    let ait = parse_non_empty(&ait, AIT_FILE_NAME)?;
    let secret_key_raw = fs::read_to_string(&secret_key_path).map_err(|source| CoreError::Io {
        path: secret_key_path.clone(),
        source,
    })?;
    let secret_key = decode_secret_key(secret_key_raw.trim())?;
    let agent_did = parse_ait_agent_did(&ait)?;

    Ok(LocalAgentProofMaterial {
        ait,
        secret_key,
        agent_did,
    })
}

fn parse_ait_agent_did(ait: &str) -> Result<String> {
    let parts: Vec<&str> = ait.split('.').collect();
    if parts.len() < 2 {
        return Err(CoreError::InvalidInput("agent AIT is invalid".to_string()));
    }
    let payload = URL_SAFE_NO_PAD
        .decode(parts[1])
        .map_err(|_| CoreError::InvalidInput("agent AIT is invalid".to_string()))?;
    let value: serde_json::Value = serde_json::from_slice(&payload)
        .map_err(|_| CoreError::InvalidInput("agent AIT is invalid".to_string()))?;
    let sub = value
        .get("sub")
        .and_then(|entry| entry.as_str())
        .ok_or_else(|| CoreError::InvalidInput("agent AIT is invalid".to_string()))?;
    let parsed = parse_did(sub)?;
    if parsed.kind != ClawDidKind::Agent {
        return Err(CoreError::InvalidInput("agent AIT is invalid".to_string()));
    }
    Ok(sub.to_string())
}

fn to_request_url(proxy_url: &str, path: &str) -> Result<String> {
    let normalized_proxy = parse_proxy_url(proxy_url)?;
    let base = if normalized_proxy.ends_with('/') {
        normalized_proxy
    } else {
        format!("{normalized_proxy}/")
    };
    let joined = url::Url::parse(&base)
        .map_err(|_| CoreError::InvalidInput("proxyUrl is invalid".to_string()))?
        .join(path.trim_start_matches('/'))
        .map_err(|_| CoreError::InvalidInput("proxyUrl is invalid".to_string()))?;
    Ok(joined.to_string())
}

fn to_path_with_query(url: &str) -> Result<String> {
    let parsed = url::Url::parse(url)
        .map_err(|_| CoreError::InvalidInput("requestUrl is invalid".to_string()))?;
    Ok(match parsed.query() {
        Some(query) => format!("{}?{query}", parsed.path()),
        None => parsed.path().to_string(),
    })
}

fn build_signed_headers(
    method: &str,
    request_url: &str,
    body_bytes: &[u8],
    secret_key: &ed25519_dalek::SigningKey,
) -> Result<Vec<(String, String)>> {
    let mut nonce_bytes = [0_u8; 24];
    getrandom_fill(&mut nonce_bytes).map_err(|error| CoreError::InvalidInput(error.to_string()))?;
    let nonce = URL_SAFE_NO_PAD.encode(nonce_bytes);
    let timestamp = format!("{}", chrono::Utc::now().timestamp());
    let signed = sign_http_request(&SignHttpRequestInput {
        method,
        path_with_query: &to_path_with_query(request_url)?,
        timestamp: &timestamp,
        nonce: &nonce,
        body: body_bytes,
        secret_key,
    })?;
    Ok(signed.headers)
}

fn parse_registry_message(payload: &serde_json::Value, fallback: &str) -> String {
    payload
        .get("error")
        .and_then(|value| value.get("message"))
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .unwrap_or_else(|| fallback.to_string())
}

fn execute_pair_request(
    request_url: &str,
    ait: &str,
    body: serde_json::Value,
    secret_key: &ed25519_dalek::SigningKey,
) -> Result<serde_json::Value> {
    let request_body = serde_json::to_string(&body)?;
    let body_bytes = request_body.as_bytes();
    let signed_headers = build_signed_headers("POST", request_url, body_bytes, secret_key)?;

    let mut request = blocking_client()?
        .post(request_url.to_string())
        .header("authorization", format!("Claw {}", ait.trim()))
        .header("content-type", "application/json");
    for (header_name, header_value) in signed_headers {
        request = request.header(header_name, header_value);
    }

    let response = request
        .body(request_body)
        .send()
        .map_err(|error| CoreError::Http(error.to_string()))?;
    let status = response.status().as_u16();
    let payload: serde_json::Value = response
        .json()
        .map_err(|error| CoreError::Http(error.to_string()))?;
    if status >= 400 {
        return Err(CoreError::HttpStatus {
            status,
            message: parse_registry_message(&payload, "pairing request failed"),
        });
    }
    Ok(payload)
}

fn resolve_peer_proxy_url(
    ticket: &str,
    profile: &PairProfile,
    peer_proxy_origin: Option<String>,
) -> Result<String> {
    let resolved_origin = peer_proxy_origin
        .and_then(|value| {
            let trimmed = value.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        })
        .or_else(|| profile.proxy_origin.clone())
        .unwrap_or(parse_pairing_ticket_issuer_origin(ticket)?);
    let origin = parse_proxy_url(&resolved_origin)?;
    to_request_url(&origin, "/hooks/agent")
}

fn persist_confirmed_peer(
    store: &SqliteStore,
    config_dir: &Path,
    ticket: &str,
    peer_did: &str,
    peer_profile: &PairProfile,
    peer_proxy_origin: Option<String>,
) -> Result<String> {
    let peer_proxy_url = resolve_peer_proxy_url(ticket, peer_profile, peer_proxy_origin)?;
    let record = persist_peer(
        store,
        PersistPeerInput {
            alias: None,
            did: peer_did.to_string(),
            proxy_url: peer_proxy_url,
            agent_name: Some(peer_profile.agent_name.clone()),
            human_name: Some(peer_profile.human_name.clone()),
        },
    )?;
    let peers_config = load_peers_config(store)?;
    sync_openclaw_relay_peers_snapshot(config_dir, &peers_config)?;
    Ok(record.alias)
}

pub fn start_pairing(
    config_dir: &Path,
    agent_name: &str,
    proxy_url: &str,
    initiator_profile: PairProfile,
    ttl_seconds: Option<u64>,
) -> Result<PairStartResult> {
    let proof = read_local_agent_proof_material(config_dir, agent_name)?;
    let request_url = to_request_url(proxy_url, PAIR_START_PATH)?;
    let payload = execute_pair_request(
        &request_url,
        &proof.ait,
        serde_json::json!({
            "ttlSeconds": ttl_seconds,
            "initiatorProfile": parse_pair_profile(&initiator_profile)?,
        }),
        &proof.secret_key,
    )?;
    let parsed: PairStartResponsePayload = serde_json::from_value(payload)
        .map_err(|error| CoreError::InvalidInput(error.to_string()))?;
    Ok(PairStartResult {
        initiator_agent_did: parse_non_empty(&parsed.initiator_agent_did, "initiatorAgentDid")?,
        initiator_profile: parse_pair_profile(&parsed.initiator_profile)?,
        ticket: parse_pairing_ticket(&parsed.ticket)?,
        expires_at: parse_non_empty(&parsed.expires_at, "expiresAt")?,
        proxy_url: parse_proxy_url(proxy_url)?,
        qr_path: None,
    })
}

pub fn confirm_pairing(
    config_dir: &Path,
    store: &SqliteStore,
    agent_name: &str,
    confirm_input: PairConfirmInput,
    responder_profile: PairProfile,
) -> Result<PairConfirmResult> {
    let ticket = match confirm_input {
        PairConfirmInput::Ticket(ticket) => parse_pairing_ticket(&ticket)?,
        PairConfirmInput::QrFile(path) => {
            let image = fs::read(&path).map_err(|source| CoreError::Io { path, source })?;
            parse_pairing_ticket(&decode_ticket_from_png(&image)?)?
        }
    };

    let proof = read_local_agent_proof_material(config_dir, agent_name)?;
    let proxy_url = parse_pairing_ticket_issuer_origin(&ticket)?;
    let request_url = to_request_url(&proxy_url, PAIR_CONFIRM_PATH)?;
    let payload = execute_pair_request(
        &request_url,
        &proof.ait,
        serde_json::json!({
            "ticket": ticket,
            "responderProfile": parse_pair_profile(&responder_profile)?,
        }),
        &proof.secret_key,
    )?;

    let parsed: PairConfirmResponsePayload = serde_json::from_value(payload)
        .map_err(|error| CoreError::InvalidInput(error.to_string()))?;
    if !parsed.paired {
        return Err(CoreError::InvalidInput(
            "pair confirm response is invalid".to_string(),
        ));
    }

    let peer_alias = persist_confirmed_peer(
        store,
        config_dir,
        &ticket,
        &parsed.initiator_agent_did,
        &parsed.initiator_profile,
        parsed.initiator_profile.proxy_origin.clone(),
    )?;

    Ok(PairConfirmResult {
        paired: true,
        initiator_agent_did: parse_non_empty(&parsed.initiator_agent_did, "initiatorAgentDid")?,
        initiator_profile: parse_pair_profile(&parsed.initiator_profile)?,
        responder_agent_did: parse_non_empty(&parsed.responder_agent_did, "responderAgentDid")?,
        responder_profile: parse_pair_profile(&parsed.responder_profile)?,
        proxy_url,
        peer_alias: Some(peer_alias),
    })
}

fn get_pairing_status_once(
    config_dir: &Path,
    store: &SqliteStore,
    agent_name: &str,
    proxy_url: &str,
    ticket: &str,
) -> Result<PairStatusResult> {
    let ticket = parse_pairing_ticket(ticket)?;
    assert_ticket_issuer_matches_proxy(&ticket, proxy_url)?;
    let proof = read_local_agent_proof_material(config_dir, agent_name)?;
    let request_url = to_request_url(proxy_url, PAIR_STATUS_PATH)?;
    let payload = execute_pair_request(
        &request_url,
        &proof.ait,
        serde_json::json!({ "ticket": ticket }),
        &proof.secret_key,
    )?;

    let parsed: PairStatusResponsePayload = serde_json::from_value(payload)
        .map_err(|error| CoreError::InvalidInput(error.to_string()))?;
    let status = match parsed.status.as_str() {
        "pending" => PairStatusKind::Pending,
        "confirmed" => PairStatusKind::Confirmed,
        _ => {
            return Err(CoreError::InvalidInput(
                "pair status response is invalid".to_string(),
            ));
        }
    };

    let mut peer_alias = None;
    if status == PairStatusKind::Confirmed {
        let responder_agent_did = parsed.responder_agent_did.clone().ok_or_else(|| {
            CoreError::InvalidInput("pair status response is invalid".to_string())
        })?;
        let responder_profile = parsed.responder_profile.clone().ok_or_else(|| {
            CoreError::InvalidInput("pair status response is invalid".to_string())
        })?;

        let (peer_did, peer_profile) = if proof.agent_did == parsed.initiator_agent_did {
            (responder_agent_did, responder_profile)
        } else if proof.agent_did == responder_agent_did {
            (
                parsed.initiator_agent_did.clone(),
                parsed.initiator_profile.clone(),
            )
        } else {
            return Err(CoreError::InvalidInput(
                "local agent is not a pairing participant".to_string(),
            ));
        };

        peer_alias = Some(persist_confirmed_peer(
            store,
            config_dir,
            &ticket,
            &peer_did,
            &peer_profile,
            peer_profile.proxy_origin.clone(),
        )?);
    }

    Ok(PairStatusResult {
        status,
        initiator_agent_did: parsed.initiator_agent_did,
        initiator_profile: parsed.initiator_profile,
        responder_agent_did: parsed.responder_agent_did,
        responder_profile: parsed.responder_profile,
        expires_at: parsed.expires_at,
        confirmed_at: parsed.confirmed_at,
        proxy_url: parse_proxy_url(proxy_url)?,
        peer_alias,
    })
}

pub fn get_pairing_status(
    config_dir: &Path,
    store: &SqliteStore,
    agent_name: &str,
    proxy_url: &str,
    ticket: &str,
    options: PairStatusOptions,
) -> Result<PairStatusResult> {
    if !options.wait {
        return get_pairing_status_once(config_dir, store, agent_name, proxy_url, ticket);
    }

    let wait_seconds = if options.wait_seconds == 0 {
        DEFAULT_STATUS_WAIT_SECONDS
    } else {
        options.wait_seconds
    };
    let poll_interval_seconds = if options.poll_interval_seconds == 0 {
        DEFAULT_STATUS_POLL_INTERVAL_SECONDS
    } else {
        options.poll_interval_seconds
    };
    let deadline = chrono::Utc::now().timestamp() + wait_seconds as i64;
    loop {
        let status = get_pairing_status_once(config_dir, store, agent_name, proxy_url, ticket)?;
        if status.status == PairStatusKind::Confirmed {
            return Ok(status);
        }

        if chrono::Utc::now().timestamp() >= deadline {
            return Err(CoreError::InvalidInput(format!(
                "pairing is still pending after {wait_seconds} seconds"
            )));
        }
        std::thread::sleep(Duration::from_secs(poll_interval_seconds));
    }
}

#[cfg(test)]
#[path = "pairing_tests.rs"]
mod tests;
