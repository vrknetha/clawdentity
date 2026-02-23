use std::fs;
use std::net::{IpAddr, SocketAddr};
use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use clap::Subcommand;
use clawdentity_core::agent::inspect_agent;
use clawdentity_core::config::{ConfigPathOptions, get_config_dir, resolve_config};
use clawdentity_core::constants::{AGENTS_DIR, AIT_FILE_NAME, SECRET_KEY_FILE_NAME};
use clawdentity_core::db::now_utc_ms;
use clawdentity_core::db_inbound::{InboundPendingItem, append_inbound_event, upsert_pending};
use clawdentity_core::http::client as create_http_client;
use clawdentity_core::runtime_openclaw::OpenclawRuntimeConfig;
use clawdentity_core::{
    CONNECTOR_FRAME_VERSION, ConnectorClient, ConnectorClientOptions, ConnectorClientSender,
    ConnectorFrame, ConnectorServiceInstallInput, ConnectorServiceUninstallInput, DeliverAckFrame,
    DeliverFrame, RuntimeServerState, SqliteStore, build_relay_connect_headers,
    fetch_registry_metadata, flush_outbound_queue_to_relay, install_connector_service,
    new_frame_id, now_iso, resolve_openclaw_base_url, resolve_openclaw_hook_token,
    spawn_connector_client, uninstall_connector_service,
};
use serde_json::{Value, json};
use tokio::sync::watch;
use tokio::task::JoinHandle;

const DEFAULT_CONNECTOR_PORT: u16 = 19400;
const DEFAULT_OPENCLAW_HOOK_PATH: &str = "/hooks/agent";
const RELAY_CONNECT_PATH: &str = "/v1/relay/connect";
const CONNECTOR_RETRY_DELAY_MS: i64 = 5_000;
const OUTBOUND_FLUSH_INTERVAL: Duration = Duration::from_millis(500);
const OUTBOUND_FLUSH_BATCH_SIZE: usize = 50;

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

struct StartConnectorInput {
    agent_name: String,
    proxy_ws_url: Option<String>,
    openclaw_base_url: Option<String>,
    openclaw_hook_path: Option<String>,
    openclaw_hook_token: Option<String>,
    port: u16,
    bind: IpAddr,
}

struct ConnectorRuntimeConfig {
    agent_name: String,
    agent_did: String,
    proxy_ws_url: String,
    relay_headers: Vec<(String, String)>,
    openclaw_runtime: OpenclawRuntimeConfig,
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

    let runtime = resolve_runtime_config(options, input).await?;
    let store = SqliteStore::open(options)?;

    let client = spawn_connector_client(ConnectorClientOptions::with_defaults(
        runtime.proxy_ws_url.clone(),
        runtime.relay_headers,
    ));
    let relay_sender = client.sender();

    let bind_addr = SocketAddr::new(runtime.bind, runtime.port);
    let (shutdown_tx, shutdown_rx) = watch::channel(false);

    let mut runtime_server_task = spawn_runtime_server_task(
        bind_addr,
        RuntimeServerState {
            store: store.clone(),
            relay_sender: Some(relay_sender.clone()),
        },
        shutdown_rx.clone(),
    );

    let mut inbound_loop_task = spawn_inbound_loop_task(
        client,
        relay_sender.clone(),
        store.clone(),
        runtime.openclaw_runtime.clone(),
        shutdown_rx.clone(),
    );

    let mut outbound_flush_task =
        spawn_outbound_flush_task(store, relay_sender.clone(), shutdown_rx);

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "agentName": runtime.agent_name,
                "agentDid": runtime.agent_did,
                "relay": runtime.proxy_ws_url,
                "outboundServer": format!("http://{}:{}", runtime.bind, runtime.port),
            }))?
        );
    } else {
        println!(
            "Connector started for agent {} (DID: {})",
            runtime.agent_name, runtime.agent_did
        );
        println!("Relay: {}", runtime.proxy_ws_url);
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
        result = &mut outbound_flush_task => {
            return Err(describe_task_exit("outbound flush loop", result));
        }
    }

    let _ = shutdown_tx.send(true);
    relay_sender.shutdown();

    await_task("runtime server", runtime_server_task).await?;
    await_task("inbound loop", inbound_loop_task).await?;
    await_task("outbound flush loop", outbound_flush_task).await?;

    Ok(())
}

async fn resolve_runtime_config(
    options: &ConfigPathOptions,
    input: StartConnectorInput,
) -> Result<ConnectorRuntimeConfig> {
    let config = resolve_config(options)?;
    let config_dir = get_config_dir(options)?;

    let inspect = inspect_agent(options, &input.agent_name)
        .with_context(|| format!("failed to inspect agent `{}`", input.agent_name))?;

    let agent_dir = config_dir.join(AGENTS_DIR).join(&input.agent_name);
    let ait = read_required_trimmed_file(&agent_dir.join(AIT_FILE_NAME), AIT_FILE_NAME)?;
    let secret_key =
        read_required_trimmed_file(&agent_dir.join(SECRET_KEY_FILE_NAME), SECRET_KEY_FILE_NAME)?;
    let signing_key = clawdentity_core::decode_secret_key(&secret_key)?;

    let proxy_ws_url = resolve_proxy_ws_url(
        input.proxy_ws_url.as_deref(),
        config.proxy_url.as_deref(),
        &config.registry_url,
    )
    .await?;

    let relay_headers = build_relay_connect_headers(&proxy_ws_url, &ait, &signing_key)?;
    let mut connector_headers = Vec::with_capacity(relay_headers.signed_headers.len() + 1);
    connector_headers.push(("authorization".to_string(), relay_headers.authorization));
    connector_headers.extend(relay_headers.signed_headers);

    let openclaw_base_url =
        resolve_openclaw_base_url(&config_dir, input.openclaw_base_url.as_deref())?;
    let openclaw_hook_path = resolve_openclaw_hook_path(input.openclaw_hook_path.as_deref());
    let openclaw_hook_token =
        resolve_openclaw_hook_token(&config_dir, input.openclaw_hook_token.as_deref())?;

    Ok(ConnectorRuntimeConfig {
        agent_name: input.agent_name,
        agent_did: inspect.did,
        proxy_ws_url,
        relay_headers: connector_headers,
        openclaw_runtime: OpenclawRuntimeConfig {
            base_url: openclaw_base_url,
            hook_path: openclaw_hook_path,
            hook_token: openclaw_hook_token,
        },
        port: input.port,
        bind: input.bind,
    })
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
    relay_sender: ConnectorClientSender,
    store: SqliteStore,
    openclaw_runtime: OpenclawRuntimeConfig,
    shutdown_rx: watch::Receiver<bool>,
) -> JoinHandle<Result<()>> {
    tokio::spawn(async move {
        run_inbound_loop(
            connector_client,
            relay_sender,
            store,
            openclaw_runtime,
            shutdown_rx,
        )
        .await
    })
}

fn spawn_outbound_flush_task(
    store: SqliteStore,
    relay_sender: ConnectorClientSender,
    shutdown_rx: watch::Receiver<bool>,
) -> JoinHandle<Result<()>> {
    tokio::spawn(async move { run_outbound_flush_loop(store, relay_sender, shutdown_rx).await })
}

async fn run_inbound_loop(
    mut connector_client: ConnectorClient,
    relay_sender: ConnectorClientSender,
    store: SqliteStore,
    openclaw_runtime: OpenclawRuntimeConfig,
    mut shutdown_rx: watch::Receiver<bool>,
) -> Result<()> {
    let hook_url = openclaw_runtime.hook_url()?;
    let http_client = create_http_client()?;

    loop {
        tokio::select! {
            _ = shutdown_rx.changed() => {
                if *shutdown_rx.borrow() {
                    return Ok(());
                }
            }
            frame = connector_client.recv_frame() => {
                let Some(frame) = frame else {
                    return Ok(());
                };
                if let ConnectorFrame::Deliver(deliver) = frame {
                    handle_deliver_frame(
                        &store,
                        &relay_sender,
                        &http_client,
                        &hook_url,
                        &openclaw_runtime,
                        deliver,
                    )
                    .await;
                }
            }
        }
    }
}

async fn run_outbound_flush_loop(
    store: SqliteStore,
    relay_sender: ConnectorClientSender,
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
                if let Err(error) = flush_outbound_queue_to_relay(
                    &store,
                    &relay_sender,
                    OUTBOUND_FLUSH_BATCH_SIZE,
                    None,
                )
                .await
                {
                    tracing::warn!(error = %error, "failed to flush outbound queue to relay");
                }
            }
        }
    }
}

async fn handle_deliver_frame(
    store: &SqliteStore,
    relay_sender: &ConnectorClientSender,
    http_client: &reqwest::Client,
    hook_url: &str,
    openclaw_runtime: &OpenclawRuntimeConfig,
    deliver: DeliverFrame,
) {
    let delivery_result =
        forward_deliver_to_openclaw(http_client, hook_url, openclaw_runtime, &deliver).await;

    let persistence_result =
        persist_inbound_delivery_result(store, &deliver, delivery_result.as_ref()).await;
    if let Err(error) = persistence_result.as_ref() {
        tracing::warn!(error = %error, request_id = %deliver.id, "failed to persist inbound delivery result");
    }

    let ack_reason = build_deliver_ack_reason(
        delivery_result.as_ref().err(),
        persistence_result.as_ref().err(),
    );
    let ack_accepted = ack_reason.is_none();
    if let Err(error) = send_deliver_ack(relay_sender, &deliver.id, ack_accepted, ack_reason).await
    {
        tracing::warn!(error = %error, request_id = %deliver.id, "failed to send deliver ack");
    }

    if let Err(error) = delivery_result {
        tracing::warn!(error = %error, request_id = %deliver.id, to_agent_did = %deliver.to_agent_did, "failed to forward inbound payload to OpenClaw hook");
    }
}

fn build_deliver_ack_reason(
    delivery_error: Option<&anyhow::Error>,
    persistence_error: Option<&anyhow::Error>,
) -> Option<String> {
    let mut reasons: Vec<String> = Vec::new();
    if let Some(error) = delivery_error {
        reasons.push(error.to_string());
    }
    if let Some(error) = persistence_error {
        reasons.push(format!(
            "failed to persist inbound delivery result: {error}"
        ));
    }

    if reasons.is_empty() {
        None
    } else {
        Some(reasons.join("; "))
    }
}

async fn forward_deliver_to_openclaw(
    http_client: &reqwest::Client,
    hook_url: &str,
    openclaw_runtime: &OpenclawRuntimeConfig,
    deliver: &DeliverFrame,
) -> Result<()> {
    let mut request = http_client
        .post(hook_url)
        .header("content-type", "application/json")
        .header("x-clawdentity-agent-did", &deliver.from_agent_did)
        .header("x-clawdentity-to-agent-did", &deliver.to_agent_did)
        .json(&build_openclaw_hook_payload(deliver));

    if let Some(token) = openclaw_runtime
        .hook_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        request = request.header("x-openclaw-token", token);
    }

    let response = request
        .send()
        .await
        .map_err(|error| anyhow!("openclaw hook request failed: {error}"))?;

    if !response.status().is_success() {
        return Err(anyhow!("openclaw hook returned HTTP {}", response.status()));
    }

    Ok(())
}

fn build_openclaw_hook_payload(deliver: &DeliverFrame) -> Value {
    json!({
        "content": extract_content(&deliver.payload),
        "senderDid": deliver.from_agent_did,
        "recipientDid": deliver.to_agent_did,
        "requestId": deliver.id,
        "metadata": {
            "conversationId": deliver.conversation_id,
            "replyTo": deliver.reply_to,
            "payload": deliver.payload,
        },
    })
}

fn extract_content(payload: &Value) -> String {
    if let Some(content) = payload.get("content").and_then(Value::as_str) {
        return content.to_string();
    }
    if let Some(text) = payload.as_str() {
        return text.to_string();
    }
    payload.to_string()
}

#[allow(clippy::too_many_lines)]
async fn persist_inbound_delivery_result(
    store: &SqliteStore,
    deliver: &DeliverFrame,
    delivery_result: std::result::Result<&(), &anyhow::Error>,
) -> Result<()> {
    let received_at_ms = now_utc_ms();
    let payload_json = deliver.payload.to_string();

    append_inbound_event(
        store,
        "received",
        Some(deliver.id.clone()),
        Some(
            json!({
                "frameId": deliver.id,
                "fromAgentDid": deliver.from_agent_did,
                "toAgentDid": deliver.to_agent_did,
            })
            .to_string(),
        ),
    )?;

    if delivery_result.is_ok() {
        append_inbound_event(
            store,
            "delivered",
            Some(deliver.id.clone()),
            Some(json!({ "frameId": deliver.id }).to_string()),
        )?;
        return Ok(());
    }

    let last_error = delivery_result
        .err()
        .map(ToString::to_string)
        .unwrap_or_else(|| "delivery failed".to_string());

    upsert_pending(
        store,
        InboundPendingItem {
            request_id: deliver.id.clone(),
            frame_id: deliver.id.clone(),
            from_agent_did: deliver.from_agent_did.clone(),
            to_agent_did: deliver.to_agent_did.clone(),
            payload_json,
            payload_bytes: i64::try_from(deliver.payload.to_string().len()).unwrap_or(i64::MAX),
            received_at_ms,
            next_attempt_at_ms: received_at_ms + CONNECTOR_RETRY_DELAY_MS,
            attempt_count: 1,
            last_error: Some(last_error),
            last_attempt_at_ms: Some(received_at_ms),
            conversation_id: deliver.conversation_id.clone(),
            reply_to: deliver.reply_to.clone(),
        },
    )?;

    append_inbound_event(
        store,
        "pending",
        Some(deliver.id.clone()),
        Some(
            json!({
                "frameId": deliver.id,
                "nextAttemptAtMs": received_at_ms + CONNECTOR_RETRY_DELAY_MS,
            })
            .to_string(),
        ),
    )?;

    Ok(())
}

async fn send_deliver_ack(
    relay_sender: &ConnectorClientSender,
    ack_id: &str,
    accepted: bool,
    reason: Option<String>,
) -> Result<()> {
    relay_sender
        .send_frame(ConnectorFrame::DeliverAck(DeliverAckFrame {
            v: CONNECTOR_FRAME_VERSION,
            id: new_frame_id(),
            ts: now_iso(),
            ack_id: ack_id.to_string(),
            accepted,
            reason,
        }))
        .await
        .map_err(anyhow::Error::from)
}

fn read_required_trimmed_file(path: &Path, label: &str) -> Result<String> {
    let raw =
        fs::read_to_string(path).with_context(|| format!("failed to read {}", path.display()))?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("{label} is empty at {}", path.display()));
    }
    Ok(trimmed.to_string())
}

fn env_trimmed(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn resolve_openclaw_hook_path(override_value: Option<&str>) -> String {
    override_value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(normalize_hook_path)
        .or_else(|| env_trimmed("OPENCLAW_HOOK_PATH").map(|value| normalize_hook_path(&value)))
        .unwrap_or_else(|| DEFAULT_OPENCLAW_HOOK_PATH.to_string())
}

fn normalize_hook_path(value: &str) -> String {
    if value.starts_with('/') {
        value.to_string()
    } else {
        format!("/{value}")
    }
}

async fn resolve_proxy_ws_url(
    explicit_proxy_ws_url: Option<&str>,
    config_proxy_url: Option<&str>,
    registry_url: &str,
) -> Result<String> {
    if let Some(value) = explicit_proxy_ws_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return normalize_proxy_ws_url(value);
    }

    if let Some(value) = env_trimmed("CLAWDENTITY_PROXY_WS_URL") {
        return normalize_proxy_ws_url(&value);
    }

    if let Some(value) = env_trimmed("CLAWDENTITY_PROXY_URL") {
        return normalize_proxy_ws_url(&value);
    }

    if let Some(value) = config_proxy_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return normalize_proxy_ws_url(value);
    }

    let metadata_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| anyhow!("failed to create metadata client: {error}"))?;

    let metadata = fetch_registry_metadata(&metadata_client, registry_url)
        .await
        .map_err(anyhow::Error::from)?;

    if metadata.proxy_url.trim().is_empty() {
        return Err(anyhow!(
            "proxy URL is required for connector startup; set --proxy-ws-url, CLAWDENTITY_PROXY_WS_URL, or CLAWDENTITY_PROXY_URL"
        ));
    }

    normalize_proxy_ws_url(&metadata.proxy_url)
}

fn normalize_proxy_ws_url(value: &str) -> Result<String> {
    let mut url =
        reqwest::Url::parse(value).map_err(|_| anyhow!("invalid proxy websocket URL: {value}"))?;

    let target_scheme = match url.scheme() {
        "ws" | "wss" => None,
        "http" => Some("ws"),
        "https" => Some("wss"),
        _ => return Err(anyhow!("invalid proxy websocket scheme in {value}")),
    };

    if let Some(scheme) = target_scheme {
        url.set_scheme(scheme)
            .map_err(|_| anyhow!("failed to normalize proxy websocket scheme for {value}"))?;
    }

    if url.path().trim().is_empty() || url.path() == "/" {
        url.set_path(RELAY_CONNECT_PATH);
    }

    Ok(url.to_string())
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
