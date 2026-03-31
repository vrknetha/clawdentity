use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use clawdentity_core::{
    ConfigPathOptions, RegistryAgentProfile, SqliteStore, UpsertPeerInput, get_peer_by_did,
    now_utc_ms, upsert_peer,
};

use super::super::headers::{SenderProfileHeaders, build_sender_profile_headers};
use super::super::runtime_config::fetch_registry_agent_profile;

const SENDER_PROFILE_CACHE_TTL_MS: i64 = 60_000;

static SENDER_PROFILE_CACHE: OnceLock<Mutex<HashMap<String, CachedSenderProfile>>> =
    OnceLock::new();

#[derive(Debug, Clone)]
struct CachedSenderProfile {
    profile: SenderProfileHeaders,
    expires_at_ms: i64,
}

#[derive(Debug, Clone)]
struct LocalSenderPeer {
    alias: String,
    did: String,
    proxy_url: String,
    framework: Option<String>,
    description: Option<String>,
    last_synced_at_ms: Option<i64>,
    profile: Option<SenderProfileHeaders>,
}

fn sender_profile_cache() -> &'static Mutex<HashMap<String, CachedSenderProfile>> {
    SENDER_PROFILE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn load_local_sender_peer(store: &SqliteStore, sender_agent_did: &str) -> Option<LocalSenderPeer> {
    match get_peer_by_did(store, sender_agent_did) {
        Ok(Some(peer)) => Some(LocalSenderPeer {
            alias: peer.alias,
            did: peer.did,
            proxy_url: peer.proxy_url,
            framework: peer.framework,
            description: peer.description,
            last_synced_at_ms: peer.last_synced_at_ms,
            profile: build_sender_profile_headers(peer.agent_name, peer.display_name),
        }),
        Ok(None) => None,
        Err(error) => {
            tracing::warn!(
                error = %error,
                sender_agent_did,
                "failed to resolve sender peer from local store"
            );
            None
        }
    }
}

fn is_profile_stale(last_synced_at_ms: Option<i64>, now_ms: i64) -> bool {
    match last_synced_at_ms {
        Some(last_synced_at_ms) => {
            now_ms.saturating_sub(last_synced_at_ms) >= SENDER_PROFILE_CACHE_TTL_MS
        }
        None => true,
    }
}

fn lookup_cached_sender_profile(
    sender_agent_did: &str,
    now_ms: i64,
) -> Option<SenderProfileHeaders> {
    let cache = sender_profile_cache().lock().ok()?;
    let entry = cache.get(sender_agent_did)?;
    if entry.expires_at_ms <= now_ms {
        return None;
    }

    Some(entry.profile.clone())
}

fn lookup_stale_cached_sender_profile(sender_agent_did: &str) -> Option<SenderProfileHeaders> {
    let cache = sender_profile_cache().lock().ok()?;
    cache
        .get(sender_agent_did)
        .map(|entry| entry.profile.clone())
}

fn remember_sender_profile(sender_agent_did: &str, profile: &SenderProfileHeaders, now_ms: i64) {
    if let Ok(mut cache) = sender_profile_cache().lock() {
        cache.retain(|_, entry| entry.expires_at_ms > now_ms);
        cache.insert(
            sender_agent_did.to_string(),
            CachedSenderProfile {
                profile: profile.clone(),
                expires_at_ms: now_ms + SENDER_PROFILE_CACHE_TTL_MS,
            },
        );
    }
}

fn sender_profile_from_registry(profile: &RegistryAgentProfile) -> SenderProfileHeaders {
    SenderProfileHeaders {
        agent_name: Some(profile.agent_name.clone()),
        display_name: Some(profile.display_name.clone()),
    }
}

fn persist_refreshed_sender_profile(
    store: &SqliteStore,
    local_peer: &LocalSenderPeer,
    registry_profile: &RegistryAgentProfile,
) {
    if let Err(error) = upsert_peer(
        store,
        UpsertPeerInput {
            alias: local_peer.alias.clone(),
            did: local_peer.did.clone(),
            proxy_url: local_peer.proxy_url.clone(),
            agent_name: Some(registry_profile.agent_name.clone()),
            display_name: Some(registry_profile.display_name.clone()),
            framework: registry_profile
                .framework
                .clone()
                .or_else(|| local_peer.framework.clone()),
            description: local_peer.description.clone(),
            last_synced_at_ms: Some(now_utc_ms()),
        },
    ) {
        tracing::warn!(
            error = %error,
            sender_agent_did = %local_peer.did,
            "failed to persist refreshed sender profile in local peer store"
        );
    }
}

fn fallback_sender_profile(
    local_peer: Option<&LocalSenderPeer>,
    sender_agent_did: &str,
) -> Option<SenderProfileHeaders> {
    local_peer
        .and_then(|peer| peer.profile.clone())
        .or_else(|| lookup_stale_cached_sender_profile(sender_agent_did))
}

async fn refresh_sender_profile_from_registry(
    options: &ConfigPathOptions,
    agent_name: &str,
    store: &SqliteStore,
    local_peer: Option<&LocalSenderPeer>,
    sender_agent_did: &str,
    now_ms: i64,
) -> Option<SenderProfileHeaders> {
    match fetch_registry_agent_profile(options, agent_name, sender_agent_did).await {
        Ok(registry_profile) => {
            if registry_profile.agent_did.trim() != sender_agent_did {
                tracing::warn!(
                    sender_agent_did,
                    fetched_agent_did = %registry_profile.agent_did,
                    "registry sender profile DID mismatch; falling back to local metadata"
                );
                return None;
            }

            let resolved_profile = sender_profile_from_registry(&registry_profile);
            remember_sender_profile(sender_agent_did, &resolved_profile, now_ms);
            if let Some(peer) = local_peer {
                persist_refreshed_sender_profile(store, peer, &registry_profile);
            }
            Some(resolved_profile)
        }
        Err(error) => {
            tracing::warn!(
                error = %error,
                sender_agent_did,
                "failed to refresh sender profile from registry for inbound delivery"
            );
            None
        }
    }
}

pub(super) async fn resolve_sender_profile_for_delivery(
    options: &ConfigPathOptions,
    agent_name: &str,
    store: &SqliteStore,
    sender_agent_did: &str,
) -> Option<SenderProfileHeaders> {
    let sender_agent_did = sender_agent_did.trim();
    if sender_agent_did.is_empty() {
        return None;
    }

    let now_ms = now_utc_ms();
    let local_peer = load_local_sender_peer(store, sender_agent_did);

    if let Some(peer) = local_peer.as_ref()
        && let Some(profile) = peer.profile.as_ref()
        && !is_profile_stale(peer.last_synced_at_ms, now_ms)
    {
        return Some(profile.clone());
    }

    if let Some(cached_profile) = lookup_cached_sender_profile(sender_agent_did, now_ms) {
        return Some(cached_profile);
    }

    if let Some(registry_profile) = refresh_sender_profile_from_registry(
        options,
        agent_name,
        store,
        local_peer.as_ref(),
        sender_agent_did,
        now_ms,
    )
    .await
    {
        return Some(registry_profile);
    }

    fallback_sender_profile(local_peer.as_ref(), sender_agent_did)
}
