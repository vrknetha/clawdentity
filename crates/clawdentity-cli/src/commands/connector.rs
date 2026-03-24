use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Result, anyhow};
use clap::Subcommand;
use clawdentity_core::config::ConfigPathOptions;
use clawdentity_core::db::now_utc_ms;
use clawdentity_core::db_inbound::{
    InboundPendingItem, append_inbound_event, delete_pending, list_pending_due,
    mark_pending_attempt, move_pending_to_dead_letter, upsert_pending,
};
use clawdentity_core::http::client as create_http_client;
use clawdentity_core::runtime_openclaw::OpenclawRuntimeConfig;
use clawdentity_core::{
    CONNECTOR_FRAME_VERSION, ConnectorClient, ConnectorClientOptions, ConnectorClientSender,
    ConnectorFrame, ConnectorServiceInstallInput, ConnectorServiceUninstallInput, CoreError,
    DeliverAckFrame, DeliverFrame, RuntimeServerState, SqliteStore, flush_outbound_queue_to_relay,
    install_connector_service, new_frame_id, now_iso, spawn_connector_client,
    uninstall_connector_service,
};
use serde_json::{Value, json};
use tokio::sync::watch;
use tokio::task::JoinHandle;

const DEFAULT_CONNECTOR_PORT: u16 = 19400;
const DEFAULT_OPENCLAW_HOOK_PATH: &str = "/hooks/wake";
const CONNECTOR_RETRY_DELAY_MS: i64 = 5_000;
const INBOUND_RETRY_INTERVAL: Duration = Duration::from_secs(1);
const INBOUND_RETRY_BATCH_SIZE: usize = 50;
const INBOUND_MAX_ATTEMPTS: i64 = 3;
const OUTBOUND_FLUSH_INTERVAL: Duration = Duration::from_millis(500);
const OUTBOUND_FLUSH_BATCH_SIZE: usize = 50;

mod runtime_config;

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

pub(super) struct ConnectorRuntimeConfig {
    agent_name: String,
    agent_did: String,
    proxy_ws_url: String,
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

    let runtime = runtime_config::resolve_runtime_config(options, input).await?;
    let store = SqliteStore::open(options)?;

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

    let mut inbound_retry_task = spawn_inbound_retry_task(
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
        result = &mut inbound_retry_task => {
            return Err(describe_task_exit("inbound retry loop", result));
        }
        result = &mut outbound_flush_task => {
            return Err(describe_task_exit("outbound flush loop", result));
        }
    }

    let _ = shutdown_tx.send(true);
    relay_sender.shutdown();

    await_task("runtime server", runtime_server_task).await?;
    await_task("inbound loop", inbound_loop_task).await?;
    await_task("inbound retry loop", inbound_retry_task).await?;
    await_task("outbound flush loop", outbound_flush_task).await?;

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

fn spawn_inbound_retry_task(
    store: SqliteStore,
    openclaw_runtime: OpenclawRuntimeConfig,
    shutdown_rx: watch::Receiver<bool>,
) -> JoinHandle<Result<()>> {
    tokio::spawn(async move { run_inbound_retry_loop(store, openclaw_runtime, shutdown_rx).await })
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
                match frame {
                    ConnectorFrame::Deliver(deliver) => {
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
                    ConnectorFrame::EnqueueAck(ack) => {
                        if ack.accepted {
                            tracing::debug!(
                                ack_id = %ack.ack_id,
                                "relay accepted outbound enqueue frame"
                            );
                        } else {
                            let reason = ack.reason.as_deref().unwrap_or("unknown");
                            tracing::warn!(
                                ack_id = %ack.ack_id,
                                reason,
                                "relay rejected outbound enqueue frame"
                            );
                        }
                    }
                    _ => {}
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

async fn run_inbound_retry_loop(
    store: SqliteStore,
    openclaw_runtime: OpenclawRuntimeConfig,
    mut shutdown_rx: watch::Receiver<bool>,
) -> Result<()> {
    let hook_url = openclaw_runtime.hook_url()?;
    let http_client = create_http_client()?;
    let mut interval = tokio::time::interval(INBOUND_RETRY_INTERVAL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            _ = shutdown_rx.changed() => {
                if *shutdown_rx.borrow() {
                    return Ok(());
                }
            }
            _ = interval.tick() => {
                retry_due_inbound_deliveries(
                    &store,
                    &http_client,
                    &hook_url,
                    &openclaw_runtime,
                )
                .await;
            }
        }
    }
}

async fn retry_due_inbound_deliveries(
    store: &SqliteStore,
    http_client: &reqwest::Client,
    hook_url: &str,
    openclaw_runtime: &OpenclawRuntimeConfig,
) {
    let due_items = match list_pending_due(store, now_utc_ms(), INBOUND_RETRY_BATCH_SIZE) {
        Ok(items) => items,
        Err(error) => {
            tracing::warn!(error = %error, "failed to list pending inbound deliveries");
            return;
        }
    };

    for item in due_items {
        retry_pending_inbound_delivery(store, http_client, hook_url, openclaw_runtime, item).await;
    }
}

async fn retry_pending_inbound_delivery(
    store: &SqliteStore,
    http_client: &reqwest::Client,
    hook_url: &str,
    openclaw_runtime: &OpenclawRuntimeConfig,
    item: InboundPendingItem,
) {
    let payload = match serde_json::from_str::<Value>(&item.payload_json) {
        Ok(payload) => payload,
        Err(error) => {
            let reason = format!("invalid pending payload_json: {error}");
            if let Err(move_error) = move_pending_to_dead_letter(store, &item.request_id, &reason) {
                tracing::warn!(
                    error = %move_error,
                    request_id = %item.request_id,
                    "failed to move invalid pending payload to dead letter"
                );
            }
            return;
        }
    };

    let deliver = DeliverFrame {
        v: CONNECTOR_FRAME_VERSION,
        id: item.request_id.clone(),
        ts: now_iso(),
        from_agent_did: item.from_agent_did.clone(),
        to_agent_did: item.to_agent_did.clone(),
        payload,
        content_type: Some("application/json".to_string()),
        conversation_id: item.conversation_id.clone(),
        reply_to: item.reply_to.clone(),
    };

    match forward_deliver_to_openclaw(http_client, hook_url, openclaw_runtime, &deliver).await {
        Ok(()) => {
            if let Err(error) = delete_pending(store, &item.request_id) {
                tracing::warn!(
                    error = %error,
                    request_id = %item.request_id,
                    "failed to clear resolved pending inbound delivery"
                );
                return;
            }
            if let Err(error) = append_inbound_event(
                store,
                "delivered_retry",
                Some(item.request_id.clone()),
                Some(
                    json!({
                        "frameId": item.frame_id,
                    })
                    .to_string(),
                ),
            ) {
                tracing::warn!(
                    error = %error,
                    request_id = %item.request_id,
                    "failed to append delivered_retry inbound event"
                );
            }
        }
        Err(error) => {
            handle_pending_retry_failure(store, &item, &error);
        }
    }
}

fn handle_pending_retry_failure(
    store: &SqliteStore,
    item: &InboundPendingItem,
    error: &anyhow::Error,
) {
    if should_dead_letter_after_failure(item.attempt_count) {
        let reason = format!("max retry attempts exceeded: {error}");
        if let Err(move_error) = move_pending_to_dead_letter(store, &item.request_id, &reason) {
            tracing::warn!(
                error = %move_error,
                request_id = %item.request_id,
                "failed to move pending inbound delivery to dead letter"
            );
        }
        return;
    }

    let next_attempt_at_ms = now_utc_ms() + CONNECTOR_RETRY_DELAY_MS;
    if let Err(mark_error) = mark_pending_attempt(
        store,
        &item.request_id,
        next_attempt_at_ms,
        Some(error.to_string()),
    ) {
        tracing::warn!(
            error = %mark_error,
            request_id = %item.request_id,
            "failed to update pending inbound retry attempt"
        );
        return;
    }
    if let Err(event_error) = append_inbound_event(
        store,
        "pending_retry",
        Some(item.request_id.clone()),
        Some(
            json!({
                "frameId": item.frame_id,
                "attemptCount": item.attempt_count + 1,
                "nextAttemptAtMs": next_attempt_at_ms,
            })
            .to_string(),
        ),
    ) {
        tracing::warn!(
            error = %event_error,
            request_id = %item.request_id,
            "failed to append pending_retry inbound event"
        );
    }
}

fn should_dead_letter_after_failure(current_attempt_count: i64) -> bool {
    current_attempt_count.saturating_add(1) >= INBOUND_MAX_ATTEMPTS
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
    match (delivery_error, persistence_error) {
        (Some(delivery_error), Some(persistence_error)) => Some(format!(
            "{delivery_error}; failed to persist inbound delivery result: {persistence_error}"
        )),
        _ => None,
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
        .json(&build_openclaw_hook_payload(
            &openclaw_runtime.hook_path,
            deliver,
        ));

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

fn build_openclaw_hook_payload(hook_path: &str, deliver: &DeliverFrame) -> Value {
    if normalize_hook_path(hook_path) == "/hooks/wake" {
        return build_openclaw_wake_payload(deliver);
    }

    build_openclaw_agent_payload(deliver)
}

fn build_openclaw_agent_payload(deliver: &DeliverFrame) -> Value {
    let message = extract_content(&deliver.payload);
    json!({
        "message": message,
        "content": message,
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

fn build_openclaw_wake_payload(deliver: &DeliverFrame) -> Value {
    let wake_text = render_openclaw_wake_text(deliver);
    let session_id = deliver
        .payload
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let mut payload = json!({
        "message": wake_text,
        "text": wake_text,
        "mode": "now",
    });
    if let Some(session_id) = session_id {
        payload["sessionId"] = Value::String(session_id.to_string());
    }
    payload
}

fn render_openclaw_wake_text(deliver: &DeliverFrame) -> String {
    let message = extract_content(&deliver.payload);
    let mut lines = vec![format!(
        "Clawdentity peer message from {}",
        deliver.from_agent_did
    )];

    if !message.trim().is_empty() {
        lines.push(String::new());
        lines.push(message);
    }

    if let Some(request_id) = Some(deliver.id.as_str()).filter(|value| !value.trim().is_empty()) {
        lines.push(String::new());
        lines.push(format!("Request ID: {request_id}"));
    }
    if let Some(conversation_id) = deliver
        .conversation_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        lines.push(format!("Conversation ID: {conversation_id}"));
    }
    if let Some(reply_to) = deliver
        .reply_to
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        lines.push(format!("Reply To: {reply_to}"));
    }

    lines.join("\n")
}

fn extract_content(payload: &Value) -> String {
    if let Some(content) = payload.get("content").and_then(Value::as_str) {
        return content.to_string();
    }
    if let Some(message) = payload.get("message").and_then(Value::as_str) {
        return message.to_string();
    }
    if let Some(text) = payload.get("text").and_then(Value::as_str) {
        return text.to_string();
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
        if let Err(error) = delete_pending(store, &deliver.id) {
            tracing::warn!(
                error = %error,
                request_id = %deliver.id,
                "failed to clear pending inbound record after successful delivery"
            );
        }
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
