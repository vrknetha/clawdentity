use serde::{Deserialize, Serialize};
use ulid::Ulid;

use crate::did::parse_agent_did;
use crate::error::{CoreError, Result};

pub const CONNECTOR_FRAME_VERSION: i64 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ConnectorFrame {
    Heartbeat(HeartbeatFrame),
    HeartbeatAck(HeartbeatAckFrame),
    Deliver(DeliverFrame),
    DeliverAck(DeliverAckFrame),
    Enqueue(EnqueueFrame),
    EnqueueAck(EnqueueAckFrame),
    Receipt(ReceiptFrame),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HeartbeatFrame {
    pub v: i64,
    pub id: String,
    pub ts: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HeartbeatAckFrame {
    pub v: i64,
    pub id: String,
    pub ts: String,
    #[serde(rename = "ackId")]
    pub ack_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeliverFrame {
    pub v: i64,
    pub id: String,
    pub ts: String,
    #[serde(rename = "fromAgentDid")]
    pub from_agent_did: String,
    #[serde(rename = "toAgentDid")]
    pub to_agent_did: String,
    pub payload: serde_json::Value,
    #[serde(rename = "contentType", skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(rename = "conversationId", skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    #[serde(rename = "replyTo", skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeliverAckFrame {
    pub v: i64,
    pub id: String,
    pub ts: String,
    #[serde(rename = "ackId")]
    pub ack_id: String,
    pub accepted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnqueueFrame {
    pub v: i64,
    pub id: String,
    pub ts: String,
    #[serde(rename = "toAgentDid")]
    pub to_agent_did: String,
    pub payload: serde_json::Value,
    #[serde(rename = "conversationId", skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    #[serde(rename = "replyTo", skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnqueueAckFrame {
    pub v: i64,
    pub id: String,
    pub ts: String,
    #[serde(rename = "ackId")]
    pub ack_id: String,
    pub accepted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReceiptStatus {
    ProcessedByOpenclaw,
    DeadLettered,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReceiptFrame {
    pub v: i64,
    pub id: String,
    pub ts: String,
    #[serde(rename = "originalFrameId")]
    pub original_frame_id: String,
    #[serde(rename = "toAgentDid")]
    pub to_agent_did: String,
    pub status: ReceiptStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

fn validate_frame_base(version: i64, id: &str, ts: &str) -> Result<()> {
    if version != CONNECTOR_FRAME_VERSION {
        return Err(CoreError::InvalidInput(format!(
            "connector frame version {version} is unsupported"
        )));
    }
    Ulid::from_string(id)
        .map_err(|_| CoreError::InvalidInput(format!("invalid frame id: {id}")))?;
    if ts.trim().is_empty() {
        return Err(CoreError::InvalidInput(
            "connector frame timestamp is required".to_string(),
        ));
    }
    Ok(())
}

fn validate_agent_did(value: &str, field_name: &str) -> Result<()> {
    let _ = parse_agent_did(value)
        .map_err(|_| CoreError::InvalidInput(format!("{field_name} must be an agent DID")))?;
    Ok(())
}

/// TODO(clawdentity): document `validate_frame`.
pub fn validate_frame(frame: &ConnectorFrame) -> Result<()> {
    match frame {
        ConnectorFrame::Heartbeat(frame) => validate_frame_base(frame.v, &frame.id, &frame.ts),
        ConnectorFrame::HeartbeatAck(frame) => {
            validate_frame_base(frame.v, &frame.id, &frame.ts)?;
            Ulid::from_string(&frame.ack_id).map_err(|_| {
                CoreError::InvalidInput(format!("invalid heartbeat ackId: {}", frame.ack_id))
            })?;
            Ok(())
        }
        ConnectorFrame::Deliver(frame) => {
            validate_frame_base(frame.v, &frame.id, &frame.ts)?;
            validate_agent_did(&frame.from_agent_did, "fromAgentDid")?;
            validate_agent_did(&frame.to_agent_did, "toAgentDid")?;
            Ok(())
        }
        ConnectorFrame::DeliverAck(frame) => {
            validate_frame_base(frame.v, &frame.id, &frame.ts)?;
            Ulid::from_string(&frame.ack_id).map_err(|_| {
                CoreError::InvalidInput(format!("invalid deliver ackId: {}", frame.ack_id))
            })?;
            Ok(())
        }
        ConnectorFrame::Enqueue(frame) => {
            validate_frame_base(frame.v, &frame.id, &frame.ts)?;
            validate_agent_did(&frame.to_agent_did, "toAgentDid")?;
            Ok(())
        }
        ConnectorFrame::EnqueueAck(frame) => {
            validate_frame_base(frame.v, &frame.id, &frame.ts)?;
            Ulid::from_string(&frame.ack_id).map_err(|_| {
                CoreError::InvalidInput(format!("invalid enqueue ackId: {}", frame.ack_id))
            })?;
            Ok(())
        }
        ConnectorFrame::Receipt(frame) => {
            validate_frame_base(frame.v, &frame.id, &frame.ts)?;
            Ulid::from_string(&frame.original_frame_id).map_err(|_| {
                CoreError::InvalidInput(format!(
                    "invalid receipt originalFrameId: {}",
                    frame.original_frame_id
                ))
            })?;
            validate_agent_did(&frame.to_agent_did, "toAgentDid")?;
            if let Some(reason) = &frame.reason
                && reason.trim().is_empty()
            {
                return Err(CoreError::InvalidInput(
                    "receipt reason must not be blank".to_string(),
                ));
            }
            Ok(())
        }
    }
}

/// TODO(clawdentity): document `parse_frame`.
pub fn parse_frame(input: impl AsRef<[u8]>) -> Result<ConnectorFrame> {
    let bytes = input.as_ref();
    let payload = std::str::from_utf8(bytes)
        .map_err(|_| CoreError::InvalidInput("connector frame must be valid UTF-8".to_string()))?;

    let frame = serde_json::from_str::<ConnectorFrame>(payload)
        .map_err(|error| CoreError::InvalidInput(error.to_string()))?;
    validate_frame(&frame)?;
    Ok(frame)
}

/// TODO(clawdentity): document `serialize_frame`.
pub fn serialize_frame(frame: &ConnectorFrame) -> Result<String> {
    validate_frame(frame)?;
    serde_json::to_string(frame).map_err(CoreError::from)
}

/// TODO(clawdentity): document `now_iso`.
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// TODO(clawdentity): document `new_frame_id`.
pub fn new_frame_id() -> String {
    Ulid::new().to_string()
}

#[cfg(test)]
mod tests {
    use super::{
        CONNECTOR_FRAME_VERSION, ConnectorFrame, EnqueueFrame, ReceiptFrame, ReceiptStatus,
        new_frame_id, now_iso, parse_frame, serialize_frame,
    };

    #[test]
    fn serialize_and_parse_enqueue_frame() {
        let frame = ConnectorFrame::Enqueue(EnqueueFrame {
            v: CONNECTOR_FRAME_VERSION,
            id: new_frame_id(),
            ts: now_iso(),
            to_agent_did: "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4"
                .to_string(),
            payload: serde_json::json!({"text":"hello"}),
            conversation_id: Some("conv-1".to_string()),
            reply_to: None,
        });

        let encoded = serialize_frame(&frame).expect("serialize");
        let decoded = parse_frame(encoded).expect("parse");
        assert_eq!(decoded, frame);
    }

    #[test]
    fn serialize_and_parse_receipt_frame() {
        let frame = ConnectorFrame::Receipt(ReceiptFrame {
            v: CONNECTOR_FRAME_VERSION,
            id: new_frame_id(),
            ts: now_iso(),
            original_frame_id: new_frame_id(),
            to_agent_did: "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4"
                .to_string(),
            status: ReceiptStatus::DeadLettered,
            reason: Some("hook rejected".to_string()),
        });

        let encoded = serialize_frame(&frame).expect("serialize");
        let decoded = parse_frame(encoded).expect("parse");
        assert_eq!(decoded, frame);
    }
}
