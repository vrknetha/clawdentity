import {
  CONNECTOR_FRAME_VERSION,
  type DeliverFrame,
  type EnqueueAckFrame,
  type EnqueueFrame,
  type HeartbeatAckFrame,
  type ReceiptFrame,
  serializeFrame,
} from "@clawdentity/connector";
import { generateUlid } from "@clawdentity/protocol";
import { nowUtcMs, toIso } from "@clawdentity/sdk";
import { RELAY_DELIVERY_SOURCE_AGENT_ENQUEUE } from "./constants.js";
import type {
  RelayDeliveryInput,
  RelayDeliveryResult,
  RelayDeliveryState,
} from "./types.js";

export function toHeartbeatFrame(nowMs: number): {
  id: string;
  payload: string;
} {
  const id = generateUlid(nowMs);
  return {
    id,
    payload: serializeFrame({
      v: CONNECTOR_FRAME_VERSION,
      type: "heartbeat",
      id,
      ts: toIso(nowMs),
    }),
  };
}

export function toHeartbeatAckFrame(ackId: string): string {
  const nowMs = nowUtcMs();
  const ackFrame: HeartbeatAckFrame = {
    v: CONNECTOR_FRAME_VERSION,
    type: "heartbeat_ack",
    id: generateUlid(nowMs),
    ts: toIso(nowMs),
    ackId,
  };

  return serializeFrame(ackFrame);
}

export function toDeliverFrame(input: RelayDeliveryInput): DeliverFrame {
  const nowMs = nowUtcMs();
  return {
    v: CONNECTOR_FRAME_VERSION,
    type: "deliver",
    id: generateUlid(nowMs),
    ts: toIso(nowMs),
    fromAgentDid: input.senderAgentDid,
    toAgentDid: input.recipientAgentDid,
    payload: input.payload,
    deliverySource: input.deliverySource,
    conversationId: input.conversationId,
    replyTo: input.replyTo,
  };
}

export function toEnqueueAckFrame(input: {
  ackId: string;
  accepted: boolean;
  reason?: string;
}): string {
  const nowMs = nowUtcMs();
  const ackFrame: EnqueueAckFrame = {
    v: CONNECTOR_FRAME_VERSION,
    type: "enqueue_ack",
    id: generateUlid(nowMs),
    ts: toIso(nowMs),
    ackId: input.ackId,
    accepted: input.accepted,
    reason: input.reason,
  };

  return serializeFrame(ackFrame);
}

export function toReceiptFramePayload(input: {
  originalFrameId: string;
  toAgentDid: string;
  status: "processed_by_openclaw" | "dead_lettered";
  reason?: string;
  nowMs: number;
}): string {
  const receiptFrame: ReceiptFrame = {
    v: CONNECTOR_FRAME_VERSION,
    type: "receipt",
    id: generateUlid(input.nowMs),
    ts: toIso(input.nowMs),
    originalFrameId: input.originalFrameId,
    toAgentDid: input.toAgentDid,
    status: input.status,
    reason: input.reason,
  };

  return serializeFrame(receiptFrame);
}

export function toRelayDeliveryInputFromEnqueueFrame(input: {
  frame: EnqueueFrame;
  senderAgentDid: string;
}): RelayDeliveryInput {
  return {
    requestId: input.frame.id,
    senderAgentDid: input.senderAgentDid,
    recipientAgentDid: input.frame.toAgentDid,
    payload: input.frame.payload,
    deliverySource: RELAY_DELIVERY_SOURCE_AGENT_ENQUEUE,
    conversationId: input.frame.conversationId,
    replyTo: input.frame.replyTo,
  };
}

export function getWebSocketMessageBytes(
  message: string | ArrayBuffer,
): number {
  if (typeof message === "string") {
    return new TextEncoder().encode(message).byteLength;
  }

  return message.byteLength;
}

export function toRelayDeliveryResult(input: {
  connectedSockets: number;
  deliveryId: string;
  queueDepth: number;
  state: RelayDeliveryState;
}): RelayDeliveryResult {
  return {
    deliveryId: input.deliveryId,
    state: input.state,
    delivered: input.state === "delivered",
    queued: input.state === "queued",
    connectedSockets: input.connectedSockets,
    queueDepth: input.queueDepth,
  };
}
