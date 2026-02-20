import type { Logger } from "@clawdentity/sdk";
import { WS_READY_STATE_OPEN } from "../constants.js";
import type { ConnectorFrame, EnqueueFrame } from "../frames.js";
import { serializeFrame } from "../frames.js";
import { sanitizeErrorReason } from "./helpers.js";
import type { ConnectorOutboundQueueManager } from "./queue.js";
import type { ConnectorWebSocket } from "./types.js";

export function sendConnectorFrame(input: {
  socket: ConnectorWebSocket | undefined;
  frame: ConnectorFrame;
  logger: Logger;
}): boolean {
  if (
    input.socket === undefined ||
    input.socket.readyState !== WS_READY_STATE_OPEN
  ) {
    return false;
  }

  const payload = serializeFrame(input.frame);

  try {
    input.socket.send(payload);
    return true;
  } catch (error) {
    input.logger.warn("connector.websocket.send_failed", {
      frameType: input.frame.type,
      reason: sanitizeErrorReason(error),
    });
    return false;
  }
}

export function flushConnectorOutboundQueue(input: {
  queue: ConnectorOutboundQueueManager;
  isConnected: () => boolean;
  sendFrame: (frame: EnqueueFrame) => boolean;
}): void {
  input.queue.flush({
    isConnected: input.isConnected,
    sendFrame: input.sendFrame,
  });
}

export async function ensureConnectorOutboundQueueLoaded(input: {
  queue: ConnectorOutboundQueueManager;
  flush: () => void;
}): Promise<void> {
  await input.queue.ensureLoaded();
  input.flush();
}
