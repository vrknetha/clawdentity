use axum::Json;
use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::HeaderMap;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use clawdentity_core::{
    CONNECTOR_FRAME_VERSION, ConnectorFrame, DeliverAckFrame, DeliverFrame, EnqueueAckFrame,
    HeartbeatAckFrame, new_frame_id, now_iso, parse_frame, serialize_frame,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use ulid::Ulid;

use crate::pairing::{
    authenticate_claw_headers, error_response, parse_agent_did_from_ait, parse_claw_token,
    to_response,
};
use crate::state::{AppState, RelayDeliverRequest};

pub async fn health_handler() -> impl IntoResponse {
    (StatusCode::OK, Json(json!({ "status": "ok" })))
}

pub async fn relay_connect_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let agent_did = match authenticate_claw_headers(&headers) {
        Ok(agent_did) => agent_did,
        Err(response) => return to_response(response),
    };

    ws.on_upgrade(move |socket| run_ws_session(state, agent_did, socket))
        .into_response()
}

pub async fn relay_deliver_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<RelayDeliverRequest>,
) -> impl IntoResponse {
    let from_agent_did = body
        .from_agent_did
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| parse_claw_token(&headers).and_then(|token| parse_agent_did_from_ait(&token)))
        .unwrap_or_else(|| format!("did:cdi:localhost:agent:{}", Ulid::new()));

    if body.to_agent_did.trim().is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "toAgentDid is required");
    }

    let frame = ConnectorFrame::Deliver(DeliverFrame {
        v: CONNECTOR_FRAME_VERSION,
        id: new_frame_id(),
        ts: now_iso(),
        from_agent_did,
        to_agent_did: body.to_agent_did.trim().to_string(),
        group_id: None,
        payload: body.payload,
        delivery_source: None,
        content_type: body.content_type,
        conversation_id: body.conversation_id,
        reply_to: body.reply_to,
    });
    let frame_id = match &frame {
        ConnectorFrame::Deliver(deliver) => deliver.id.clone(),
        _ => new_frame_id(),
    };
    let delivered = route_or_queue_frame(&state, body.to_agent_did.trim(), frame).await;
    (
        StatusCode::OK,
        Json(json!({
            "accepted": true,
            "frameId": frame_id,
            "delivered": delivered,
            "queued": !delivered,
        })),
    )
}

async fn run_ws_session(state: AppState, agent_did: String, socket: WebSocket) {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Message>();
    {
        let mut routes = state.routes.lock().await;
        routes.insert(agent_did.clone(), tx.clone());
    }

    {
        let mut queued = state.queued.lock().await;
        if let Some(pending_frames) = queued.remove(&agent_did) {
            for frame in pending_frames {
                if let Ok(payload) = serialize_frame(&frame) {
                    let _ = tx.send(Message::Text(payload.into()));
                }
            }
        }
    }

    let (mut ws_sender, mut ws_receiver) = socket.split();
    let write_task = tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            if ws_sender.send(message).await.is_err() {
                break;
            }
        }
    });

    while let Some(message_result) = ws_receiver.next().await {
        let message = match message_result {
            Ok(message) => message,
            Err(_) => break,
        };
        match message {
            Message::Text(text) => {
                if let Ok(frame) = parse_frame(text.as_str()) {
                    handle_client_frame(&state, &agent_did, frame, &tx).await;
                }
            }
            Message::Binary(bytes) => {
                if let Ok(frame) = parse_frame(bytes) {
                    handle_client_frame(&state, &agent_did, frame, &tx).await;
                }
            }
            Message::Ping(payload) => {
                let _ = tx.send(Message::Pong(payload));
            }
            Message::Pong(_) => {}
            Message::Close(_) => break,
        }
    }

    {
        let mut routes = state.routes.lock().await;
        routes.remove(&agent_did);
    }
    write_task.abort();
}

async fn handle_client_frame(
    state: &AppState,
    sender_did: &str,
    frame: ConnectorFrame,
    sender_tx: &tokio::sync::mpsc::UnboundedSender<Message>,
) {
    match frame {
        ConnectorFrame::Heartbeat(heartbeat) => {
            let ack = ConnectorFrame::HeartbeatAck(HeartbeatAckFrame {
                v: CONNECTOR_FRAME_VERSION,
                id: new_frame_id(),
                ts: now_iso(),
                ack_id: heartbeat.id,
            });
            let _ = send_frame(sender_tx, &ack);
        }
        ConnectorFrame::Enqueue(enqueue) => {
            let ack = ConnectorFrame::EnqueueAck(EnqueueAckFrame {
                v: CONNECTOR_FRAME_VERSION,
                id: new_frame_id(),
                ts: now_iso(),
                ack_id: enqueue.id.clone(),
                accepted: true,
                reason: None,
            });
            let _ = send_frame(sender_tx, &ack);

            let deliver = ConnectorFrame::Deliver(DeliverFrame {
                v: CONNECTOR_FRAME_VERSION,
                id: new_frame_id(),
                ts: now_iso(),
                from_agent_did: sender_did.to_string(),
                to_agent_did: enqueue.to_agent_did.clone(),
                group_id: enqueue.group_id,
                payload: enqueue.payload,
                delivery_source: None,
                content_type: None,
                conversation_id: enqueue.conversation_id,
                reply_to: enqueue.reply_to,
            });
            let _ = route_or_queue_frame(state, &enqueue.to_agent_did, deliver).await;
        }
        ConnectorFrame::Deliver(deliver) => {
            let ack = ConnectorFrame::DeliverAck(DeliverAckFrame {
                v: CONNECTOR_FRAME_VERSION,
                id: new_frame_id(),
                ts: now_iso(),
                ack_id: deliver.id.clone(),
                accepted: true,
                reason: None,
            });
            let _ = send_frame(sender_tx, &ack);
            let target_did = deliver.to_agent_did.clone();
            let _ =
                route_or_queue_frame(state, &target_did, ConnectorFrame::Deliver(deliver)).await;
        }
        ConnectorFrame::HeartbeatAck(_) => {}
        ConnectorFrame::EnqueueAck(_) => {}
        ConnectorFrame::DeliverAck(_) => {}
        ConnectorFrame::Receipt(receipt) => {
            let target_did = receipt.to_agent_did.clone();
            let _ =
                route_or_queue_frame(state, &target_did, ConnectorFrame::Receipt(receipt)).await;
        }
    }
}

async fn route_or_queue_frame(state: &AppState, target_did: &str, frame: ConnectorFrame) -> bool {
    let payload = match serialize_frame(&frame) {
        Ok(payload) => payload,
        Err(_) => return false,
    };

    let route = {
        let routes = state.routes.lock().await;
        routes.get(target_did).cloned()
    };
    if let Some(tx) = route
        && tx.send(Message::Text(payload.into())).is_ok()
    {
        return true;
    }

    let mut queued = state.queued.lock().await;
    queued
        .entry(target_did.to_string())
        .or_default()
        .push(frame);
    false
}

fn send_frame(
    sender: &tokio::sync::mpsc::UnboundedSender<Message>,
    frame: &ConnectorFrame,
) -> Result<(), String> {
    let payload = serialize_frame(frame).map_err(|error| error.to_string())?;
    sender
        .send(Message::Text(payload.into()))
        .map_err(|_| "connection closed".to_string())
}
