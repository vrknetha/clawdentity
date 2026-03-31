use anyhow::{Result, anyhow};
use clap::Subcommand;
use clawdentity_core::config::get_config_dir;
use clawdentity_core::db::now_utc_ms;
use clawdentity_core::{
    ConfigPathOptions, SqliteStore, UpsertPeerInput, get_peer_by_alias, load_peers_config,
    parse_agent_did, sync_openclaw_relay_peers_snapshot, upsert_peer,
};
use serde::Serialize;

use crate::commands::connector::runtime_config::fetch_registry_agent_profile;

#[derive(Debug, Subcommand)]
pub enum PeerCommand {
    Refresh {
        #[arg(long)]
        agent_name: String,
        alias: Option<String>,
        #[arg(long)]
        all: bool,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PeerRefreshResultRow {
    alias: String,
    did: String,
    refreshed: bool,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PeerRefreshSummary {
    refreshed_count: usize,
    failed_count: usize,
    results: Vec<PeerRefreshResultRow>,
}

/// TODO(clawdentity): document `execute_peer_command`.
pub async fn execute_peer_command(
    options: &ConfigPathOptions,
    command: PeerCommand,
    json: bool,
) -> Result<()> {
    match command {
        PeerCommand::Refresh {
            agent_name,
            alias,
            all,
        } => execute_peer_refresh(options, &agent_name, alias, all, json).await,
    }
}

#[allow(clippy::too_many_lines)]
async fn execute_peer_refresh(
    options: &ConfigPathOptions,
    agent_name: &str,
    alias: Option<String>,
    all: bool,
    json: bool,
) -> Result<()> {
    if all && alias.is_some() {
        return Err(anyhow!("pass either a peer alias or --all, not both"));
    }
    if !all && alias.is_none() {
        return Err(anyhow!("peer alias is required unless --all is provided"));
    }

    let store = SqliteStore::open(options)?;
    let target_aliases = if all {
        clawdentity_core::list_peers(&store)?
            .into_iter()
            .map(|peer| peer.alias)
            .collect::<Vec<_>>()
    } else {
        vec![alias.expect("validated peer alias")]
    };

    let mut results: Vec<PeerRefreshResultRow> = Vec::with_capacity(target_aliases.len());
    for peer_alias in target_aliases {
        let refreshed = refresh_one_peer(options, agent_name, &store, &peer_alias).await;
        match refreshed {
            Ok(did) => results.push(PeerRefreshResultRow {
                alias: peer_alias,
                did,
                refreshed: true,
                error: None,
            }),
            Err(error) => results.push(PeerRefreshResultRow {
                alias: peer_alias,
                did: String::new(),
                refreshed: false,
                error: Some(error.to_string()),
            }),
        }
    }

    let refreshed_count = results.iter().filter(|row| row.refreshed).count();
    let failed_count = results.len().saturating_sub(refreshed_count);

    if refreshed_count > 0 {
        let config_dir = get_config_dir(options)?;
        let peers_config = load_peers_config(&store)?;
        sync_openclaw_relay_peers_snapshot(&config_dir, &peers_config)?;
    }

    let summary = PeerRefreshSummary {
        refreshed_count,
        failed_count,
        results,
    };
    if json {
        println!("{}", serde_json::to_string_pretty(&summary)?);
    } else {
        println!(
            "Peer refresh completed: {} refreshed, {} failed",
            summary.refreshed_count, summary.failed_count
        );
        for row in &summary.results {
            if row.refreshed {
                println!("- {}: refreshed ({})", row.alias, row.did);
            } else if let Some(error) = row.error.as_deref() {
                println!("- {}: failed ({})", row.alias, error);
            }
        }
    }

    if failed_count > 0 && !all {
        return Err(anyhow!(
            "peer refresh failed for alias {}",
            summary
                .results
                .first()
                .map(|row| row.alias.clone())
                .unwrap_or_else(|| "unknown".to_string())
        ));
    }

    Ok(())
}

async fn refresh_one_peer(
    options: &ConfigPathOptions,
    agent_name: &str,
    store: &SqliteStore,
    peer_alias: &str,
) -> Result<String> {
    let peer = get_peer_by_alias(store, peer_alias)?
        .ok_or_else(|| anyhow!("peer alias `{peer_alias}` was not found"))?;
    parse_agent_did(peer.did.as_str()).map_err(|error| anyhow!("peer DID is invalid: {error}"))?;

    let profile = fetch_registry_agent_profile(options, agent_name, &peer.did).await?;
    upsert_peer(
        store,
        UpsertPeerInput {
            alias: peer.alias.clone(),
            did: peer.did.clone(),
            proxy_url: peer.proxy_url.clone(),
            agent_name: Some(profile.agent_name),
            display_name: Some(profile.display_name),
            framework: profile.framework,
            description: None,
            last_synced_at_ms: Some(now_utc_ms()),
        },
    )?;

    Ok(peer.did)
}
