use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::db::SqliteStore;
use crate::db_peers::{PeerRecord, UpsertPeerInput, list_peers, upsert_peer};
use crate::did::{ClawDidKind, parse_did};
use crate::error::{CoreError, Result};

const OPENCLAW_RELAY_RUNTIME_FILE_NAME: &str = "openclaw-relay.json";
const FILE_MODE: u32 = 0o600;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerEntry {
    pub did: String,
    pub proxy_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub human_name: Option<String>,
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
    pub human_name: Option<String>,
}

/// TODO(clawdentity): document `derive_peer_alias_base`.
pub fn derive_peer_alias_base(peer_did: &str) -> String {
    if let Ok(parsed) = parse_did(peer_did)
        && parsed.kind == ClawDidKind::Agent
    {
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
                human_name: peer.human_name,
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
            human_name: input.human_name,
        },
    )
}

fn set_secure_permissions(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(FILE_MODE)).map_err(|source| {
            CoreError::Io {
                path: path.to_path_buf(),
                source,
            }
        })?;
    }
    Ok(())
}

fn parse_snapshot_path_from_runtime_config(raw: &str) -> Option<PathBuf> {
    let parsed = serde_json::from_str::<serde_json::Value>(raw).ok()?;
    let path = parsed
        .get("relayTransformPeersPath")
        .and_then(|value| value.as_str())?
        .trim();
    if path.is_empty() {
        None
    } else {
        Some(PathBuf::from(path))
    }
}

/// TODO(clawdentity): document `sync_openclaw_relay_peers_snapshot`.
pub fn sync_openclaw_relay_peers_snapshot(config_dir: &Path, peers: &PeersConfig) -> Result<()> {
    let runtime_config_path = config_dir.join(OPENCLAW_RELAY_RUNTIME_FILE_NAME);
    let runtime_raw = match fs::read_to_string(&runtime_config_path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(source) => {
            return Err(CoreError::Io {
                path: runtime_config_path,
                source,
            });
        }
    };

    let Some(snapshot_path) = parse_snapshot_path_from_runtime_config(&runtime_raw) else {
        return Ok(());
    };
    if let Some(parent) = snapshot_path.parent() {
        fs::create_dir_all(parent).map_err(|source| CoreError::Io {
            path: parent.to_path_buf(),
            source,
        })?;
    }

    let body = serde_json::to_string_pretty(peers)?;
    fs::write(&snapshot_path, format!("{body}\n")).map_err(|source| CoreError::Io {
        path: snapshot_path.clone(),
        source,
    })?;
    set_secure_permissions(&snapshot_path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use crate::db::SqliteStore;

    use super::{
        PersistPeerInput, load_peers_config, persist_peer, sync_openclaw_relay_peers_snapshot,
    };

    #[test]
    fn persist_peer_generates_alias_and_loads_config() {
        let temp = TempDir::new().expect("temp dir");
        let store = SqliteStore::open_path(temp.path().join("db.sqlite3")).expect("open db");

        let peer = persist_peer(
            &store,
            PersistPeerInput {
                alias: None,
                did: "did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4".to_string(),
                proxy_url: "https://proxy.example/hooks/agent".to_string(),
                agent_name: Some("Alpha".to_string()),
                human_name: Some("Alice".to_string()),
            },
        )
        .expect("persist");
        assert!(peer.alias.starts_with("peer-"));

        let loaded = load_peers_config(&store).expect("load");
        assert_eq!(loaded.peers.len(), 1);
    }

    #[test]
    fn sync_writes_peer_snapshot_when_runtime_config_references_path() {
        let temp = TempDir::new().expect("temp dir");
        let snapshot_path = temp.path().join("relay-peers.json");
        std::fs::write(
            temp.path().join("openclaw-relay.json"),
            format!(
                "{{\"relayTransformPeersPath\":\"{}\"}}",
                snapshot_path.display()
            ),
        )
        .expect("runtime config");

        let peers = super::PeersConfig {
            peers: [(
                "alpha".to_string(),
                super::PeerEntry {
                    did: "did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4".to_string(),
                    proxy_url: "https://proxy.example/hooks/agent".to_string(),
                    agent_name: None,
                    human_name: None,
                },
            )]
            .into_iter()
            .collect(),
        };
        sync_openclaw_relay_peers_snapshot(temp.path(), &peers).expect("sync");
        assert!(snapshot_path.exists());
    }
}
