import {
  CONNECTOR_FRAME_VERSION,
  type DeliverFrame,
  type HeartbeatAckFrame,
  serializeFrame,
} from "@clawdentity/connector";
import { generateUlid } from "@clawdentity/protocol";
import { nowUtcMs, toIso } from "@clawdentity/sdk";
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
    conversationId: input.conversationId,
    replyTo: input.replyTo,
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
