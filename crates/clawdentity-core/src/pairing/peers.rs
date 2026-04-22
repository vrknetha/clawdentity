use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::db::SqliteStore;
use crate::db_peers::{PeerRecord, UpsertPeerInput, list_peers, upsert_peer};
use crate::did::parse_agent_did;
use crate::error::{CoreError, Result};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerEntry {
    pub did: String,
    pub proxy_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub framework: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_synced_at_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeersConfig {
    pub peers: BTreeMap<String, PeerEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersistPeerInput {
    pub alias: Option<String>,
    pub did: String,
    pub proxy_url: String,
    pub agent_name: Option<String>,
    pub display_name: Option<String>,
    pub framework: Option<String>,
    pub description: Option<String>,
    pub last_synced_at_ms: Option<i64>,
}

/// TODO(clawdentity): document `derive_peer_alias_base`.
pub fn derive_peer_alias_base(peer_did: &str) -> String {
    if let Ok(parsed) = parse_agent_did(peer_did) {
        let suffix = parsed
            .ulid
            .chars()
            .rev()
            .take(8)
            .collect::<String>()
            .chars()
            .rev()
            .collect::<String>()
            .to_ascii_lowercase();
        return format!("peer-{suffix}");
    }
    "peer".to_string()
}

/// TODO(clawdentity): document `load_peers_config`.
pub fn load_peers_config(store: &SqliteStore) -> Result<PeersConfig> {
    let peers = list_peers(store)?;
    let mut by_alias = BTreeMap::<String, PeerEntry>::new();
    for peer in peers {
        by_alias.insert(
            peer.alias,
            PeerEntry {
                did: peer.did,
                proxy_url: peer.proxy_url,
                agent_name: peer.agent_name,
                display_name: peer.display_name,
                framework: peer.framework,
                description: peer.description,
                last_synced_at_ms: peer.last_synced_at_ms,
            },
        );
    }
    Ok(PeersConfig { peers: by_alias })
}

/// TODO(clawdentity): document `resolve_peer_alias`.
pub fn resolve_peer_alias(store: &SqliteStore, peer_did: &str) -> Result<String> {
    let existing = list_peers(store)?;
    for peer in &existing {
        if peer.did == peer_did {
            return Ok(peer.alias.clone());
        }
    }

    let base = derive_peer_alias_base(peer_did);
    if !existing.iter().any(|peer| peer.alias == base) {
        return Ok(base);
    }

    let mut index = 2_usize;
    loop {
        let candidate = format!("{base}-{index}");
        if !existing.iter().any(|peer| peer.alias == candidate) {
            return Ok(candidate);
        }
        index += 1;
    }
}

/// TODO(clawdentity): document `persist_peer`.
pub fn persist_peer(store: &SqliteStore, input: PersistPeerInput) -> Result<PeerRecord> {
    let did = input.did.trim().to_string();
    if did.is_empty() {
        return Err(CoreError::InvalidInput("peer did is required".to_string()));
    }
    let alias = match input.alias {
        Some(alias) if !alias.trim().is_empty() => alias.trim().to_string(),
        _ => resolve_peer_alias(store, &did)?,
    };

    upsert_peer(
        store,
        UpsertPeerInput {
            alias,
            did,
            proxy_url: input.proxy_url,
            agent_name: input.agent_name,
            display_name: input.display_name,
            framework: input.framework,
            description: input.description,
            last_synced_at_ms: input.last_synced_at_ms,
        },
    )
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use crate::db::SqliteStore;

    use super::{PersistPeerInput, load_peers_config, persist_peer};

    #[test]
    fn persist_peer_generates_alias_and_loads_config() {
        let temp = TempDir::new().expect("temp dir");
        let store = SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("open db");

        let peer = persist_peer(
            &store,
            PersistPeerInput {
                alias: None,
                did: "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4"
                    .to_string(),
                proxy_url: "https://proxy.example/hooks/message".to_string(),
                agent_name: Some("Alpha".to_string()),
                display_name: Some("Alice".to_string()),
                framework: Some("generic".to_string()),
                description: Some("test peer".to_string()),
                last_synced_at_ms: Some(123),
            },
        )
        .expect("persist");
        assert!(peer.alias.starts_with("peer-"));

        let loaded = load_peers_config(&store).expect("load");
        assert_eq!(loaded.peers.len(), 1);
    }
}
