import type { Logger } from "@clawdentity/sdk";
import {
  type ConnectorFrame,
  type DeliverFrame,
  type HeartbeatAckFrame,
  type HeartbeatFrame,
  parseFrame,
  type ReceiptFrame,
} from "../frames.js";
import { sanitizeErrorReason } from "./helpers.js";

type ConnectorInboundMessageHandlers = {
  onFrame?: (frame: ConnectorFrame) => void;
  onHeartbeatFrame: (frame: HeartbeatFrame) => void;
  onHeartbeatAckFrame: (frame: HeartbeatAckFrame) => void;
  onDeliverFrame: (frame: DeliverFrame) => Promise<void>;
  onReceiptFrame: (frame: ReceiptFrame) => Promise<void>;
};

type HandleIncomingConnectorMessageInput = {
  rawFrame: unknown;
  logger: Logger;
  handlers: ConnectorInboundMessageHandlers;
};

export async function handleIncomingConnectorMessage(
  input: HandleIncomingConnectorMessageInput,
): Promise<void> {
  let frame: ConnectorFrame;

  try {
    frame = parseFrame(input.rawFrame);
  } catch (error) {
    input.logger.warn("connector.frame.parse_failed", {
      reason: sanitizeErrorReason(error),
    });
    return;
  }

  input.handlers.onFrame?.(frame);

  if (frame.type === "heartbeat") {
    input.handlers.onHeartbeatFrame(frame);
    return;
  }

  if (frame.type === "heartbeat_ack") {
    input.handlers.onHeartbeatAckFrame(frame);
    return;
  }

  if (frame.type === "deliver") {
    await input.handlers.onDeliverFrame(frame);
    return;
  }

  if (frame.type === "receipt") {
    await input.handlers.onReceiptFrame(frame);
  }
}
