use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Result, anyhow};
use clap::Subcommand;
use clawdentity_core::config::ConfigPathOptions;
use clawdentity_core::http::client as create_http_client;
use clawdentity_core::runtime_openclaw::OpenclawRuntimeConfig;
use clawdentity_core::{
    ConnectorClient, ConnectorClientOptions, ConnectorClientSender, ConnectorServiceInstallInput,
    ConnectorServiceUninstallInput, CoreError, OutboundSendObservation, RuntimeServerState,
    SqliteStore, UpsertPeerInput, flush_outbound_queue_to_relay_with_send_observer,
    install_connector_service, list_peers, load_peers_config, now_utc_ms, spawn_connector_client,
    sync_openclaw_relay_peers_snapshot, uninstall_connector_service, upsert_peer,
};
use serde_json::json;
use tokio::sync::watch;
use tokio::task::JoinHandle;

const DEFAULT_CONNECTOR_PORT: u16 = 19400;
const DEFAULT_OPENCLAW_HOOK_PATH: &str = "/hooks/agent";
const OUTBOUND_FLUSH_INTERVAL: Duration = Duration::from_millis(500);
const OUTBOUND_FLUSH_BATCH_SIZE: usize = 50;
const PEER_REFRESH_INTERVAL: Duration = Duration::from_secs(60 * 60 * 24);
type OutboundInflightMap = Arc<Mutex<HashMap<String, String>>>;

mod delivery;
mod headers;
mod receipts;
pub(crate) mod runtime_config;

use delivery::{
    InboundLoopRuntime, InboundRetryRuntime, PendingReceiptQueueHandle, run_inbound_loop,
    run_inbound_retry_loop,
};
use receipts::{ReceiptDispatchRuntime, start_receipt_outbox_worker};

#[cfg(test)]
use delivery::{
    build_deliver_ack_reason, build_openclaw_hook_payload, build_openclaw_receipt_payload,
    forward_deliver_to_openclaw, forward_deliver_to_provider, resolve_group_name_for_delivery,
    resolve_sender_profile_for_delivery, should_dead_letter_after_failure,
};
#[cfg(test)]
use headers::{SenderProfileHeaders, build_openclaw_delivery_headers};

#[derive(Debug, Subcommand)]
pub enum ConnectorCommand {
    Start {
        name: String,
        #[arg(long)]
        proxy_ws_url: Option<String>,
        #[arg(long)]
        openclaw_base_url: Option<String>,
        #[arg(long)]
        openclaw_hook_path: Option<String>,
        #[arg(long)]
        openclaw_hook_token: Option<String>,
        #[arg(long, default_value_t = DEFAULT_CONNECTOR_PORT)]
        port: u16,
        #[arg(long, default_value = "127.0.0.1")]
        bind: IpAddr,
    },
    Service {
        #[command(subcommand)]
        command: ConnectorServiceCommand,
    },
}

#[derive(Debug, Subcommand)]
pub enum ConnectorServiceCommand {
    Install {
        name: String,
        #[arg(long)]
        platform: Option<String>,
        #[arg(long)]
        proxy_ws_url: Option<String>,
        #[arg(long)]
        openclaw_base_url: Option<String>,
        #[arg(long)]
        openclaw_hook_path: Option<String>,
        #[arg(long)]
        openclaw_hook_token: Option<String>,
    },
    Uninstall {
        name: String,
        #[arg(long)]
        platform: Option<String>,
    },
}

pub(super) struct StartConnectorInput {
    agent_name: String,
    proxy_ws_url: Option<String>,
    openclaw_base_url: Option<String>,
    openclaw_hook_path: Option<String>,
    openclaw_hook_token: Option<String>,
    port: u16,
    bind: IpAddr,
}

#[derive(Debug, Clone)]
pub(super) struct ProviderInboundRuntime {
    pub provider: String,
    pub display_name: String,
    pub webhook_endpoint: String,
    pub webhook_token: Option<String>,
}

#[derive(Debug, Clone)]
pub(super) enum InboundDeliveryTarget {
    Openclaw(OpenclawRuntimeConfig),
    Provider(ProviderInboundRuntime),
}

impl InboundDeliveryTarget {
    fn kind(&self) -> &'static str {
        match self {
            Self::Openclaw(_) => "openclaw",
            Self::Provider(_) => "provider",
        }
    }

    fn platform_name(&self) -> &str {
        match self {
            Self::Openclaw(_) => "openclaw",
            Self::Provider(runtime) => runtime.provider.as_str(),
        }
    }

    fn display_name(&self) -> &str {
        match self {
            Self::Openclaw(_) => "OpenClaw",
            Self::Provider(runtime) => runtime.display_name.as_str(),
        }
    }
}

#[derive(Debug)]
pub(super) struct ConnectorRuntimeConfig {
    agent_name: String,
    agent_did: String,
    config_dir: PathBuf,
    proxy_receipt_url: String,
    proxy_ws_url: String,
    inbound_target: InboundDeliveryTarget,
    port: u16,
    bind: IpAddr,
}
/// TODO(clawdentity): document `execute_connector_command`.
pub async fn execute_connector_command(
    options: &ConfigPathOptions,
    command: ConnectorCommand,
    json: bool,
) -> Result<()> {
    match command {
        ConnectorCommand::Start {
            name,
            proxy_ws_url,
            openclaw_base_url,
            openclaw_hook_path,
            openclaw_hook_token,
            port,
            bind,
        } => {
            start_connector_runtime(
                options,
                StartConnectorInput {
                    agent_name: name,
                    proxy_ws_url,
                    openclaw_base_url,
                    openclaw_hook_path,
                    openclaw_hook_token,
                    port,
                    bind,
                },
                json,
            )
            .await
        }
        ConnectorCommand::Service { command } => {
            execute_connector_service_command(options, command, json)
        }
    }
}
#[allow(clippy::too_many_lines)]
fn execute_connector_service_command(
    options: &ConfigPathOptions,
    command: ConnectorServiceCommand,
    json: bool,
) -> Result<()> {
    match command {
        ConnectorServiceCommand::Install {
            name,
            platform,
            proxy_ws_url,
            openclaw_base_url,
            openclaw_hook_path,
            openclaw_hook_token,
        } => {
            let result = install_connector_service(
                options,
                ConnectorServiceInstallInput {
                    agent_name: name,
                    platform,
                    proxy_ws_url,
                    openclaw_base_url,
                    openclaw_hook_path,
                    openclaw_hook_token,
                    executable_path: None,
                },
            )?;
            if json {
                println!("{}", serde_json::to_string_pretty(&result)?);
            } else {
                println!(
                    "Connector service installed ({}): {}",
                    result.platform, result.service_name
                );
                println!("Service file: {}", result.service_file_path.display());
                println!("Logs (stdout): {}", result.output_log_path.display());
                println!("Logs (stderr): {}", result.error_log_path.display());
            }
        }
        ConnectorServiceCommand::Uninstall { name, platform } => {
            let result = uninstall_connector_service(
                options,
                ConnectorServiceUninstallInput {
                    agent_name: name,
                    platform,
                },
            )?;
            if json {
                println!("{}", serde_json::to_string_pretty(&result)?);
            } else {
                println!(
                    "Connector service uninstalled ({}): {}",
                    result.platform, result.service_name
                );
                println!(
                    "Service file removed: {}",
                    result.service_file_path.display()
                );
            }
        }
    }

    Ok(())
}
#[allow(clippy::too_many_lines)]
async fn start_connector_runtime(
    options: &ConfigPathOptions,
    input: StartConnectorInput,
    json: bool,
) -> Result<()> {
    if input.port == 0 {
        return Err(anyhow!("--port must be a valid TCP port"));
    }

    let runtime = runtime_config::resolve_runtime_config(options, input).await?;
    let store = SqliteStore::open(options)?;
    let (local_group_echo_tx, local_group_echo_rx) = tokio::sync::mpsc::unbounded_channel();

    let header_options = options.clone();
    let header_agent_name = runtime.agent_name.clone();
    let header_proxy_ws_url = runtime.proxy_ws_url.clone();
    let client = spawn_connector_client(
        ConnectorClientOptions::with_defaults(runtime.proxy_ws_url.clone(), vec![])
            .with_headers_provider(Arc::new(move || {
                runtime_config::load_connector_headers(
                    &header_options,
                    &header_agent_name,
                    &header_proxy_ws_url,
                )
                .map_err(|error| {
                    CoreError::InvalidInput(format!(
                        "failed to build connector relay headers: {error}"
                    ))
                })
            })),
    );
    let relay_sender = client.sender();

    let bind_addr = SocketAddr::new(runtime.bind, runtime.port);
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let group_members_options = options.clone();
    let group_members_agent_name = runtime.agent_name.clone();
    let group_members_resolver = Arc::new(
        move |group_id: String| -> std::pin::Pin<
            Box<dyn std::future::Future<Output = std::result::Result<Vec<String>, String>> + Send>,
        > {
            let options = group_members_options.clone();
            let agent_name = group_members_agent_name.clone();
            Box::pin(async move {
                runtime_config::fetch_group_member_dids(&options, &agent_name, &group_id)
                    .await
                    .map_err(|error| error.to_string())
            })
        },
    );

    let mut runtime_server_task = spawn_runtime_server_task(
        bind_addr,
        RuntimeServerState {
            store: store.clone(),
            relay_sender: Some(relay_sender.clone()),
            outbound_max_pending_override: None,
            group_members_resolver: Some(group_members_resolver),
            local_agent_did: Some(runtime.agent_did.clone()),
            local_group_echo_sender: Some(local_group_echo_tx),
        },
        shutdown_rx.clone(),
    );

    let receipt_outbox = start_receipt_outbox_worker(
        ReceiptDispatchRuntime {
            options: options.clone(),
            config_dir: runtime.config_dir.clone(),
            agent_name: runtime.agent_name.clone(),
            proxy_receipt_url: runtime.proxy_receipt_url.clone(),
        },
        create_http_client()?,
    );
    let outbound_inflight: OutboundInflightMap = Arc::new(Mutex::new(HashMap::new()));
    let pending_receipt_notifications: PendingReceiptQueueHandle = Arc::new(Mutex::new(Vec::new()));

    let inbound_runtime = InboundLoopRuntime {
        options: options.clone(),
        agent_name: runtime.agent_name.clone(),
        receipt_outbox: receipt_outbox.clone(),
        relay_sender: relay_sender.clone(),
        store: store.clone(),
        config_dir: runtime.config_dir.clone(),
        inbound_target: runtime.inbound_target.clone(),
        outbound_inflight: outbound_inflight.clone(),
        pending_receipt_notifications: pending_receipt_notifications.clone(),
        local_group_echo_rx,
    };
    let mut inbound_loop_task =
        spawn_inbound_loop_task(client, inbound_runtime, shutdown_rx.clone());

    let mut inbound_retry_task = spawn_inbound_retry_task(InboundRetryRuntime {
        options: options.clone(),
        agent_name: runtime.agent_name.clone(),
        receipt_outbox,
        store: store.clone(),
        config_dir: runtime.config_dir.clone(),
        inbound_target: runtime.inbound_target.clone(),
        pending_receipt_notifications,
        shutdown_rx: shutdown_rx.clone(),
    });

    let mut outbound_flush_task = spawn_outbound_flush_task(
        store.clone(),
        relay_sender.clone(),
        outbound_inflight,
        shutdown_rx.clone(),
    );
    let mut peer_refresh_task = spawn_peer_refresh_task(
        options.clone(),
        runtime.agent_name.clone(),
        runtime.config_dir.clone(),
        store.clone(),
        shutdown_rx.clone(),
    );

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "agentName": runtime.agent_name,
                "agentDid": runtime.agent_did,
                "relay": runtime.proxy_ws_url,
                "deliveryTarget": {
                    "kind": runtime.inbound_target.kind(),
                    "platform": runtime.inbound_target.platform_name(),
                    "displayName": runtime.inbound_target.display_name(),
                },
                "outboundServer": format!("http://{}:{}", runtime.bind, runtime.port),
            }))?
        );
    } else {
        println!(
            "Connector started for agent {} (DID: {})",
            runtime.agent_name, runtime.agent_did
        );
        println!("Relay: {}", runtime.proxy_ws_url);
        println!(
            "Inbound delivery target: {} ({})",
            runtime.inbound_target.display_name(),
            runtime.inbound_target.platform_name()
        );
        println!("Outbound server: http://{}:{}", runtime.bind, runtime.port);
    }

    tokio::select! {
        signal_result = wait_for_shutdown_signal() => {
            signal_result?;
        }
        result = &mut runtime_server_task => {
            return Err(describe_task_exit("runtime server", result));
        }
        result = &mut inbound_loop_task => {
            return Err(describe_task_exit("inbound loop", result));
        }
        result = &mut inbound_retry_task => {
            return Err(describe_task_exit("inbound retry loop", result));
        }
        result = &mut outbound_flush_task => {
            return Err(describe_task_exit("outbound flush loop", result));
        }
        result = &mut peer_refresh_task => {
            return Err(describe_task_exit("peer refresh loop", result));
        }
    }

    let _ = shutdown_tx.send(true);
    relay_sender.shutdown();

    await_task("runtime server", runtime_server_task).await?;
    await_task("inbound loop", inbound_loop_task).await?;
    await_task("inbound retry loop", inbound_retry_task).await?;
    await_task("outbound flush loop", outbound_flush_task).await?;
    await_task("peer refresh loop", peer_refresh_task).await?;

    Ok(())
}

fn spawn_runtime_server_task(
    bind_addr: SocketAddr,
    state: RuntimeServerState,
    shutdown_rx: watch::Receiver<bool>,
) -> JoinHandle<Result<()>> {
    tokio::spawn(async move {
        let mut shutdown_rx = shutdown_rx;
        clawdentity_core::run_runtime_server(bind_addr, state, async move {
            while !*shutdown_rx.borrow() {
                if shutdown_rx.changed().await.is_err() {
                    break;
                }
            }
        })
        .await
        .map_err(anyhow::Error::from)
    })
}

fn spawn_inbound_loop_task(
    connector_client: ConnectorClient,
    runtime: InboundLoopRuntime,
    shutdown_rx: watch::Receiver<bool>,
) -> JoinHandle<Result<()>> {
    tokio::spawn(async move { run_inbound_loop(connector_client, runtime, shutdown_rx).await })
}

fn spawn_outbound_flush_task(
    store: SqliteStore,
    relay_sender: ConnectorClientSender,
    outbound_inflight: OutboundInflightMap,
    shutdown_rx: watch::Receiver<bool>,
) -> JoinHandle<Result<()>> {
    tokio::spawn(async move {
        run_outbound_flush_loop(store, relay_sender, outbound_inflight, shutdown_rx).await
    })
}

fn spawn_inbound_retry_task(runtime: InboundRetryRuntime) -> JoinHandle<Result<()>> {
    tokio::spawn(async move { run_inbound_retry_loop(runtime).await })
}

fn spawn_peer_refresh_task(
    options: ConfigPathOptions,
    agent_name: String,
    config_dir: PathBuf,
    store: SqliteStore,
    shutdown_rx: watch::Receiver<bool>,
) -> JoinHandle<Result<()>> {
    tokio::spawn(async move {
        run_peer_refresh_loop(options, &agent_name, config_dir, store, shutdown_rx).await
    })
}

async fn run_outbound_flush_loop(
    store: SqliteStore,
    relay_sender: ConnectorClientSender,
    outbound_inflight: OutboundInflightMap,
    mut shutdown_rx: watch::Receiver<bool>,
) -> Result<()> {
    let mut interval = tokio::time::interval(OUTBOUND_FLUSH_INTERVAL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            _ = shutdown_rx.changed() => {
                if *shutdown_rx.borrow() {
                    return Ok(());
                }
            }
            _ = interval.tick() => {
                if !relay_sender.is_connected() {
                    continue;
                }
                match flush_outbound_queue_to_relay_with_send_observer(
                    &store,
                    &relay_sender,
                    OUTBOUND_FLUSH_BATCH_SIZE,
                    None,
                    |sent, observation| {
                        if let Ok(mut guard) = outbound_inflight.lock() {
                            match observation {
                                OutboundSendObservation::Queued => {
                                    guard.insert(sent.frame_id.clone(), sent.to_agent_did.clone());
                                }
                                OutboundSendObservation::SendFailed => {
                                    guard.remove(&sent.frame_id);
                                }
                                OutboundSendObservation::Sent => {}
                            }
                        }
                    },
                )
                .await
                {
                    Ok(_) => {}
                    Err(error) => {
                        tracing::warn!(error = %error, "failed to flush outbound queue to relay");
                    }
                }
            }
        }
    }
}

async fn run_peer_refresh_loop(
    options: ConfigPathOptions,
    agent_name: &str,
    config_dir: PathBuf,
    store: SqliteStore,
    mut shutdown_rx: watch::Receiver<bool>,
) -> Result<()> {
    if refresh_peer_profiles_once(
        &options,
        agent_name,
        config_dir.as_path(),
        &store,
        &mut shutdown_rx,
    )
    .await
    {
        return Ok(());
    }
    let mut interval = tokio::time::interval(PEER_REFRESH_INTERVAL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            _ = shutdown_rx.changed() => {
                if *shutdown_rx.borrow() {
                    return Ok(());
                }
            }
            _ = interval.tick() => {
                if refresh_peer_profiles_once(
                    &options,
                    agent_name,
                    config_dir.as_path(),
                    &store,
                    &mut shutdown_rx,
                )
                .await
                {
                    return Ok(());
                }
            }
        }
    }
}

#[allow(clippy::too_many_lines)]
async fn refresh_peer_profiles_once(
    options: &ConfigPathOptions,
    agent_name: &str,
    config_dir: &Path,
    store: &SqliteStore,
    shutdown_rx: &mut watch::Receiver<bool>,
) -> bool {
    if *shutdown_rx.borrow() {
        return true;
    }

    let peers = match list_peers(store) {
        Ok(peers) => peers,
        Err(error) => {
            tracing::warn!(error = %error, "failed to list peers for periodic refresh");
            return false;
        }
    };
    if peers.is_empty() {
        return false;
    }

    let mut refreshed_any = false;
    for peer in peers {
        if *shutdown_rx.borrow() {
            return true;
        }

        tokio::select! {
            changed = shutdown_rx.changed() => {
                if changed.is_err() || *shutdown_rx.borrow() {
                    return true;
                }
                continue;
            }
            profile_result = runtime_config::fetch_registry_agent_profile(options, agent_name, &peer.did) => match profile_result {
            Ok(profile) => {
                let update = upsert_peer(
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
                );
                if let Err(error) = update {
                    tracing::warn!(
                        error = %error,
                        alias = %peer.alias,
                        "failed to persist periodic peer profile refresh"
                    );
                } else {
                    refreshed_any = true;
                }
            }
            Err(error) => {
                tracing::warn!(
                    error = %error,
                    alias = %peer.alias,
                    did = %peer.did,
                    "failed to refresh peer profile from registry"
                );
            }
            }
        }
    }

    if refreshed_any && !*shutdown_rx.borrow() {
        match load_peers_config(store)
            .and_then(|peers_config| sync_openclaw_relay_peers_snapshot(config_dir, &peers_config))
        {
            Ok(()) => {}
            Err(error) => {
                tracing::warn!(error = %error, "failed to sync relay peer snapshot after periodic refresh");
            }
        }
    }

    false
}

pub(super) fn env_trimmed(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(super) fn normalize_hook_path(value: &str) -> String {
    if value.starts_with('/') {
        value.to_string()
    } else {
        format!("/{value}")
    }
}

fn describe_task_exit(
    task_name: &str,
    join_result: std::result::Result<Result<()>, tokio::task::JoinError>,
) -> anyhow::Error {
    match join_result {
        Ok(Ok(())) => anyhow!("{task_name} stopped unexpectedly"),
        Ok(Err(error)) => anyhow!("{task_name} failed: {error}"),
        Err(error) => anyhow!("{task_name} panicked: {error}"),
    }
}

async fn await_task(task_name: &str, handle: JoinHandle<Result<()>>) -> Result<()> {
    match handle.await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(anyhow!("{task_name} failed: {error}")),
        Err(error) => Err(anyhow!("{task_name} panicked: {error}")),
    }
}

#[cfg(unix)]
async fn wait_for_shutdown_signal() -> Result<()> {
    use tokio::signal::unix::{SignalKind, signal};

    let mut terminate = signal(SignalKind::terminate())
        .map_err(|error| anyhow!("failed to install SIGTERM handler: {error}"))?;

    tokio::select! {
        signal_result = tokio::signal::ctrl_c() => {
            signal_result.map_err(|error| anyhow!("failed to listen for Ctrl+C: {error}"))?;
        }
        _ = terminate.recv() => {}
    }

    Ok(())
}

#[cfg(not(unix))]
async fn wait_for_shutdown_signal() -> Result<()> {
    tokio::signal::ctrl_c()
        .await
        .map_err(|error| anyhow!("failed to listen for Ctrl+C: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests;
