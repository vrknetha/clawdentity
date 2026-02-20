import type { Logger } from "@clawdentity/sdk";
import { CONNECTOR_FRAME_VERSION } from "../constants.js";
import type {
  ConnectorFrame,
  DeliverFrame,
  HeartbeatAckFrame,
} from "../frames.js";
import type { LocalOpenclawDeliveryClient } from "./delivery.js";
import type { ConnectorHeartbeatManager } from "./heartbeat.js";
import { handleIncomingConnectorMessage } from "./inbound.js";
import { handleInboundDeliverFrame } from "./inbound-delivery.js";
import type { ConnectorClientHooks } from "./types.js";

export async function routeConnectorInboundMessage(options: {
  rawFrame: unknown;
  logger: Logger;
  hooks: ConnectorClientHooks;
  heartbeatManager: ConnectorHeartbeatManager;
  inboundDeliverHandler:
    | ((frame: DeliverFrame) => Promise<{ accepted: boolean; reason?: string }>)
    | undefined;
  localOpenclawDelivery: LocalOpenclawDeliveryClient;
  isStarted: () => boolean;
  makeFrameId: () => string;
  makeTimestamp: () => string;
  now: () => number;
  sendFrame: (frame: ConnectorFrame) => boolean;
  recordAckLatency: (durationMs: number) => void;
}): Promise<void> {
  await handleIncomingConnectorMessage({
    rawFrame: options.rawFrame,
    logger: options.logger,
    handlers: {
      onFrame: options.hooks.onFrame,
      onHeartbeatFrame: (frame) => {
        const ackFrame: HeartbeatAckFrame = {
          v: CONNECTOR_FRAME_VERSION,
          type: "heartbeat_ack",
          id: options.makeFrameId(),
          ts: options.makeTimestamp(),
          ackId: frame.id,
        };

        options.sendFrame(ackFrame);
      },
      onHeartbeatAckFrame: (frame) => {
        options.heartbeatManager.handleHeartbeatAck(frame);
      },
      onDeliverFrame: async (frame: DeliverFrame) => {
        await handleInboundDeliverFrame({
          frame,
          inboundDeliverHandler: options.inboundDeliverHandler,
          localOpenclawDelivery: options.localOpenclawDelivery,
          isStarted: options.isStarted,
          hooks: options.hooks,
          now: options.now,
          makeFrameId: options.makeFrameId,
          makeTimestamp: options.makeTimestamp,
          sendDeliverAckFrame: (ackFrame) => {
            options.sendFrame(ackFrame);
          },
          recordAckLatency: options.recordAckLatency,
        });
      },
    },
  });
}
