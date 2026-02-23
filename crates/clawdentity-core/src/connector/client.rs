use std::cmp;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use futures_util::{Sink, SinkExt, StreamExt};
use serde::Serialize;
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};

use crate::connector_frames::{
    CONNECTOR_FRAME_VERSION, ConnectorFrame, HeartbeatAckFrame, HeartbeatFrame, new_frame_id,
    now_iso, parse_frame, serialize_frame,
};
use crate::error::{CoreError, Result};

const DEFAULT_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(20);
const DEFAULT_HEARTBEAT_ACK_TIMEOUT: Duration = Duration::from_secs(15);
const DEFAULT_RECONNECT_MIN_DELAY: Duration = Duration::from_millis(500);
const DEFAULT_RECONNECT_MAX_DELAY: Duration = Duration::from_secs(15);

#[derive(Debug, Clone)]
pub struct ConnectorClientOptions {
    pub relay_connect_url: String,
    pub headers: Vec<(String, String)>,
    pub heartbeat_interval: Duration,
    pub heartbeat_ack_timeout: Duration,
    pub reconnect_min_delay: Duration,
    pub reconnect_max_delay: Duration,
}

impl ConnectorClientOptions {
/// TODO(clawdentity): document `with_defaults`.
    pub fn with_defaults(
        relay_connect_url: impl Into<String>,
        headers: Vec<(String, String)>,
    ) -> Self {
        Self {
            relay_connect_url: relay_connect_url.into(),
            headers,
            heartbeat_interval: DEFAULT_HEARTBEAT_INTERVAL,
            heartbeat_ack_timeout: DEFAULT_HEARTBEAT_ACK_TIMEOUT,
            reconnect_min_delay: DEFAULT_RECONNECT_MIN_DELAY,
            reconnect_max_delay: DEFAULT_RECONNECT_MAX_DELAY,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ConnectorClientMetricsSnapshot {
    pub connected: bool,
    pub reconnect_attempts: u64,
    pub heartbeat_sent: u64,
    pub heartbeat_ack_timeouts: u64,
}

struct ConnectorClientMetrics {
    connected: AtomicBool,
    reconnect_attempts: AtomicU64,
    heartbeat_sent: AtomicU64,
    heartbeat_ack_timeouts: AtomicU64,
}

impl ConnectorClientMetrics {
    fn new() -> Self {
        Self {
            connected: AtomicBool::new(false),
            reconnect_attempts: AtomicU64::new(0),
            heartbeat_sent: AtomicU64::new(0),
            heartbeat_ack_timeouts: AtomicU64::new(0),
        }
    }

    fn snapshot(&self) -> ConnectorClientMetricsSnapshot {
        ConnectorClientMetricsSnapshot {
            connected: self.connected.load(Ordering::SeqCst),
            reconnect_attempts: self.reconnect_attempts.load(Ordering::SeqCst),
            heartbeat_sent: self.heartbeat_sent.load(Ordering::SeqCst),
            heartbeat_ack_timeouts: self.heartbeat_ack_timeouts.load(Ordering::SeqCst),
        }
    }
}

#[derive(Clone)]
pub struct ConnectorClientSender {
    sender: mpsc::Sender<ConnectorFrame>,
    metrics: Arc<ConnectorClientMetrics>,
    shutdown_tx: watch::Sender<bool>,
}

impl ConnectorClientSender {
/// TODO(clawdentity): document `send_frame`.
    pub async fn send_frame(&self, frame: ConnectorFrame) -> Result<()> {
        self.sender
            .send(frame)
            .await
            .map_err(|_| CoreError::InvalidInput("connector client is not running".to_string()))
    }

/// TODO(clawdentity): document `is_connected`.
    pub fn is_connected(&self) -> bool {
        self.metrics.connected.load(Ordering::SeqCst)
    }

/// TODO(clawdentity): document `metrics_snapshot`.
    pub fn metrics_snapshot(&self) -> ConnectorClientMetricsSnapshot {
        self.metrics.snapshot()
    }

/// TODO(clawdentity): document `shutdown`.
    pub fn shutdown(&self) {
        let _ = self.shutdown_tx.send(true);
    }
}

pub struct ConnectorClient {
    sender: ConnectorClientSender,
    inbound_rx: mpsc::Receiver<ConnectorFrame>,
}

impl ConnectorClient {
/// TODO(clawdentity): document `sender`.
    pub fn sender(&self) -> ConnectorClientSender {
        self.sender.clone()
    }

/// TODO(clawdentity): document `recv_frame`.
    pub async fn recv_frame(&mut self) -> Option<ConnectorFrame> {
        self.inbound_rx.recv().await
    }
}

/// TODO(clawdentity): document `spawn_connector_client`.
pub fn spawn_connector_client(options: ConnectorClientOptions) -> ConnectorClient {
    let (outbound_tx, outbound_rx) = mpsc::channel::<ConnectorFrame>(256);
    let (inbound_tx, inbound_rx) = mpsc::channel::<ConnectorFrame>(256);
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let metrics = Arc::new(ConnectorClientMetrics::new());

    tokio::spawn(run_connector_loop(
        options,
        outbound_rx,
        inbound_tx,
        metrics.clone(),
        shutdown_rx,
    ));

    ConnectorClient {
        sender: ConnectorClientSender {
            sender: outbound_tx,
            metrics,
            shutdown_tx,
        },
        inbound_rx,
    }
}

enum SessionExit {
    Reconnect,
    Shutdown,
}

#[allow(clippy::too_many_lines)]
async fn run_connector_loop(
    options: ConnectorClientOptions,
    mut outbound_rx: mpsc::Receiver<ConnectorFrame>,
    inbound_tx: mpsc::Sender<ConnectorFrame>,
    metrics: Arc<ConnectorClientMetrics>,
    mut shutdown_rx: watch::Receiver<bool>,
) {
    let mut backoff = options.reconnect_min_delay;
    loop {
        if *shutdown_rx.borrow() {
            break;
        }

        let attempt = metrics.reconnect_attempts.fetch_add(1, Ordering::SeqCst) + 1;
        tracing::info!(
            relay_connect_url = %options.relay_connect_url,
            attempt,
            "connector websocket connect attempt"
        );
        let stream = match connect_socket(&options).await {
            Ok(stream) => {
                tracing::info!(
                    relay_connect_url = %options.relay_connect_url,
                    "connector websocket connected"
                );
                Some(stream)
            }
            Err(error) => {
                tracing::warn!(
                    relay_connect_url = %options.relay_connect_url,
                    attempt,
                    error = %error,
                    "connector websocket connect failed"
                );
                None
            }
        };
        if let Some(stream) = stream {
            metrics.connected.store(true, Ordering::SeqCst);
            let exit = run_socket_session(
                stream,
                &options,
                &mut outbound_rx,
                &inbound_tx,
                metrics.clone(),
                &mut shutdown_rx,
            )
            .await;
            metrics.connected.store(false, Ordering::SeqCst);

            match exit {
                SessionExit::Shutdown => break,
                SessionExit::Reconnect => {
                    tracing::warn!(
                        relay_connect_url = %options.relay_connect_url,
                        "connector websocket session ended; reconnecting"
                    );
                    backoff = options.reconnect_min_delay;
                }
            }
        }

        if *shutdown_rx.borrow() {
            break;
        }

        tokio::select! {
            _ = shutdown_rx.changed() => {
                if *shutdown_rx.borrow() {
                    break;
                }
            }
            _ = tokio::time::sleep(backoff) => {}
        }
        backoff = next_backoff(backoff, options.reconnect_max_delay);
    }
}

fn next_backoff(current: Duration, max: Duration) -> Duration {
    let doubled = current.saturating_mul(2);
    cmp::min(doubled, max)
}

fn heartbeat_ack_timed_out(
    pending_heartbeat_ack: &Option<(String, Instant)>,
    heartbeat_ack_timeout: Duration,
) -> bool {
    pending_heartbeat_ack
        .as_ref()
        .is_some_and(|(_, sent_at)| sent_at.elapsed() >= heartbeat_ack_timeout)
}

async fn connect_socket(
    options: &ConnectorClientOptions,
) -> Result<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
> {
    let mut request = options
        .relay_connect_url
        .clone()
        .into_client_request()
        .map_err(|error| CoreError::InvalidInput(error.to_string()))?;

    for (name, value) in &options.headers {
        let header_name =
            tokio_tungstenite::tungstenite::http::header::HeaderName::from_bytes(name.as_bytes())
                .map_err(|error| CoreError::InvalidInput(error.to_string()))?;
        let header_value =
            tokio_tungstenite::tungstenite::http::header::HeaderValue::from_str(value)
                .map_err(|error| CoreError::InvalidInput(error.to_string()))?;
        request.headers_mut().insert(header_name, header_value);
    }

    let (stream, _response) = connect_async(request)
        .await
        .map_err(|error| CoreError::Http(error.to_string()))?;
    Ok(stream)
}

#[allow(clippy::too_many_lines)]
async fn run_socket_session(
    stream: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    options: &ConnectorClientOptions,
    outbound_rx: &mut mpsc::Receiver<ConnectorFrame>,
    inbound_tx: &mpsc::Sender<ConnectorFrame>,
    metrics: Arc<ConnectorClientMetrics>,
    shutdown_rx: &mut watch::Receiver<bool>,
) -> SessionExit {
    let (mut write, mut read) = stream.split();
    let mut heartbeat_tick = tokio::time::interval(options.heartbeat_interval);
    heartbeat_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    let mut pending_heartbeat_ack: Option<(String, Instant)> = None;

    loop {
        tokio::select! {
            _ = shutdown_rx.changed() => {
                if *shutdown_rx.borrow() {
                    let _ = write.send(Message::Close(None)).await;
                    return SessionExit::Shutdown;
                }
            }
            outbound = outbound_rx.recv() => {
                let Some(frame) = outbound else {
                    let _ = write.send(Message::Close(None)).await;
                    return SessionExit::Shutdown;
                };
                let payload = match serialize_frame(&frame) {
                    Ok(payload) => payload,
                    Err(_) => continue,
                };
                if write.send(Message::Text(payload.into())).await.is_err() {
                    return SessionExit::Reconnect;
                }
            }
            _ = heartbeat_tick.tick() => {
                if heartbeat_ack_timed_out(&pending_heartbeat_ack, options.heartbeat_ack_timeout) {
                    metrics
                        .heartbeat_ack_timeouts
                        .fetch_add(1, Ordering::SeqCst);
                    tracing::warn!("connector heartbeat ack timeout; reconnecting");
                    return SessionExit::Reconnect;
                }

                if pending_heartbeat_ack.is_some() {
                    continue;
                }

                let heartbeat = ConnectorFrame::Heartbeat(HeartbeatFrame {
                    v: CONNECTOR_FRAME_VERSION,
                    id: new_frame_id(),
                    ts: now_iso(),
                });
                let frame_id = match &heartbeat {
                    ConnectorFrame::Heartbeat(frame) => frame.id.clone(),
                    _ => String::new(),
                };
                let payload = match serialize_frame(&heartbeat) {
                    Ok(payload) => payload,
                    Err(_) => continue,
                };
                if write.send(Message::Text(payload.into())).await.is_err() {
                    return SessionExit::Reconnect;
                }
                metrics.heartbeat_sent.fetch_add(1, Ordering::SeqCst);
                pending_heartbeat_ack = Some((frame_id, Instant::now()));
            }
            incoming = read.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        if handle_incoming_frame(
                            &text,
                            &mut write,
                            inbound_tx,
                            &mut pending_heartbeat_ack,
                        ).await.is_err() {
                            return SessionExit::Reconnect;
                        }
                    }
                    Some(Ok(Message::Binary(bytes))) => {
                        if handle_incoming_frame(
                            &bytes,
                            &mut write,
                            inbound_tx,
                            &mut pending_heartbeat_ack,
                        ).await.is_err() {
                            return SessionExit::Reconnect;
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        if write.send(Message::Pong(payload)).await.is_err() {
                            return SessionExit::Reconnect;
                        }
                    }
                    Some(Ok(Message::Close(_))) => {
                        return SessionExit::Reconnect;
                    }
                    Some(Ok(Message::Pong(_))) => {}
                    Some(Ok(Message::Frame(_))) => {}
                    Some(Err(_)) | None => {
                        return SessionExit::Reconnect;
                    }
                }
            }
        }

        if heartbeat_ack_timed_out(&pending_heartbeat_ack, options.heartbeat_ack_timeout) {
            metrics
                .heartbeat_ack_timeouts
                .fetch_add(1, Ordering::SeqCst);
            tracing::warn!("connector heartbeat ack timeout; reconnecting");
            return SessionExit::Reconnect;
        }
    }
}

async fn handle_incoming_frame(
    payload: impl AsRef<[u8]>,
    write: &mut (impl Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin),
    inbound_tx: &mpsc::Sender<ConnectorFrame>,
    pending_heartbeat_ack: &mut Option<(String, Instant)>,
) -> Result<()> {
    let frame = parse_frame(payload)?;
    match &frame {
        ConnectorFrame::Heartbeat(heartbeat) => {
            let ack = ConnectorFrame::HeartbeatAck(HeartbeatAckFrame {
                v: CONNECTOR_FRAME_VERSION,
                id: new_frame_id(),
                ts: now_iso(),
                ack_id: heartbeat.id.clone(),
            });
            let payload = serialize_frame(&ack)?;
            write
                .send(Message::Text(payload.into()))
                .await
                .map_err(|error| CoreError::Http(error.to_string()))?;
        }
        ConnectorFrame::HeartbeatAck(ack) => {
            if let Some((pending_id, _)) = pending_heartbeat_ack
                && pending_id == &ack.ack_id
            {
                *pending_heartbeat_ack = None;
            }
        }
        _ => {
            let _ = inbound_tx.send(frame).await;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::{ConnectorClientOptions, heartbeat_ack_timed_out, spawn_connector_client};

    #[tokio::test]
    async fn client_sender_exposes_default_metrics_snapshot() {
        let client = spawn_connector_client(ConnectorClientOptions::with_defaults(
            "ws://127.0.0.1:9/v1/relay/connect",
            vec![],
        ));
        tokio::time::sleep(Duration::from_millis(50)).await;
        let snapshot = client.sender().metrics_snapshot();
        assert!(!snapshot.connected);
        assert!(snapshot.reconnect_attempts >= 1);
        client.sender().shutdown();
    }

    #[test]
    fn heartbeat_ack_timeout_helper_handles_missing_pending_ack() {
        let timed_out = heartbeat_ack_timed_out(&None, Duration::from_secs(15));
        assert!(!timed_out);
    }

    #[test]
    fn heartbeat_ack_timeout_helper_detects_expired_ack() {
        let pending = Some(("hb-1".to_string(), Instant::now() - Duration::from_secs(20)));
        let timed_out = heartbeat_ack_timed_out(&pending, Duration::from_secs(15));
        assert!(timed_out);
    }

    #[test]
    fn heartbeat_ack_timeout_helper_allows_recent_ack() {
        let pending = Some(("hb-1".to_string(), Instant::now()));
        let timed_out = heartbeat_ack_timed_out(&pending, Duration::from_secs(15));
        assert!(!timed_out);
    }
}
