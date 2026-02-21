import { CONNECTOR_FRAME_VERSION } from "../constants.js";
import type { DeliverAckFrame, DeliverFrame } from "../frames.js";
import type { LocalOpenclawDeliveryClient } from "./delivery.js";
import { sanitizeErrorReason } from "./helpers.js";
import type { ConnectorClientHooks } from "./types.js";

function createDeliverAckFrame(input: {
  ackId: string;
  accepted: boolean;
  reason?: string;
  makeFrameId: () => string;
  makeTimestamp: () => string;
}): DeliverAckFrame {
  return {
    v: CONNECTOR_FRAME_VERSION,
    type: "deliver_ack",
    id: input.makeFrameId(),
    ts: input.makeTimestamp(),
    ackId: input.ackId,
    accepted: input.accepted,
    reason: input.reason,
  };
}

export async function handleInboundDeliverFrame(input: {
  frame: DeliverFrame;
  inboundDeliverHandler:
    | ((frame: DeliverFrame) => Promise<{ accepted: boolean; reason?: string }>)
    | undefined;
  localOpenclawDelivery: LocalOpenclawDeliveryClient;
  isStarted: () => boolean;
  hooks: ConnectorClientHooks;
  now: () => number;
  makeFrameId: () => string;
  makeTimestamp: () => string;
  sendDeliverAckFrame: (frame: DeliverAckFrame) => void;
  recordAckLatency: (durationMs: number) => void;
}): Promise<void> {
  const startedAtMs = input.now();

  if (input.inboundDeliverHandler !== undefined) {
    try {
      const result = await input.inboundDeliverHandler(input.frame);
      input.sendDeliverAckFrame(
        createDeliverAckFrame({
          ackId: input.frame.id,
          accepted: result.accepted,
          reason: result.reason,
          makeFrameId: input.makeFrameId,
          makeTimestamp: input.makeTimestamp,
        }),
      );

      if (result.accepted) {
        input.hooks.onDeliverSucceeded?.(input.frame);
      } else {
        input.hooks.onDeliverFailed?.(
          input.frame,
          new Error(
            result.reason ?? "Inbound delivery was rejected by runtime handler",
          ),
        );
      }

      input.recordAckLatency(input.now() - startedAtMs);
    } catch (error) {
      input.sendDeliverAckFrame(
        createDeliverAckFrame({
          ackId: input.frame.id,
          accepted: false,
          reason: sanitizeErrorReason(error),
          makeFrameId: input.makeFrameId,
          makeTimestamp: input.makeTimestamp,
        }),
      );
      input.hooks.onDeliverFailed?.(input.frame, error);
      input.recordAckLatency(input.now() - startedAtMs);
    }
    return;
  }

  try {
    await input.localOpenclawDelivery.deliverWithRetry(
      input.frame,
      input.isStarted,
    );
    input.sendDeliverAckFrame(
      createDeliverAckFrame({
        ackId: input.frame.id,
        accepted: true,
        makeFrameId: input.makeFrameId,
        makeTimestamp: input.makeTimestamp,
      }),
    );
    input.hooks.onDeliverSucceeded?.(input.frame);
    input.recordAckLatency(input.now() - startedAtMs);
  } catch (error) {
    input.sendDeliverAckFrame(
      createDeliverAckFrame({
        ackId: input.frame.id,
        accepted: false,
        reason: sanitizeErrorReason(error),
        makeFrameId: input.makeFrameId,
        makeTimestamp: input.makeTimestamp,
      }),
    );
    input.hooks.onDeliverFailed?.(input.frame, error);
    input.recordAckLatency(input.now() - startedAtMs);
  }
}
