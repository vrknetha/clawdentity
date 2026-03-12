import {
  DEFAULT_RELAY_DELIVER_TIMEOUT_MS,
  serializeFrame,
} from "@clawdentity/connector";
import { toDeliverFrame } from "./frames.js";
import { rejectPendingDeliveries } from "./pending-deliveries.js";
import type {
  PendingDelivery,
  RelayDeliveryInput,
  RelayDeliveryPolicy,
} from "./types.js";

export class RelayDeliveryTransport {
  private readonly pendingDeliveries = new Map<string, PendingDelivery>();

  constructor(private readonly deliveryPolicy: RelayDeliveryPolicy) {}

  getPendingCount(): number {
    return this.pendingDeliveries.size;
  }

  rejectPending(error: Error): void {
    rejectPendingDeliveries(this.pendingDeliveries, error);
  }

  resolveDeliverAck(ackId: string, accepted: boolean): void {
    const pending = this.pendingDeliveries.get(ackId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeoutHandle);
    this.pendingDeliveries.delete(ackId);
    pending.resolve(accepted);
  }

  async sendDeliverFrame(
    socket: WebSocket,
    input: RelayDeliveryInput,
  ): Promise<boolean> {
    if (
      this.pendingDeliveries.size >= this.deliveryPolicy.maxInFlightDeliveries
    ) {
      throw new Error("Relay connector in-flight window is full");
    }

    const frame = toDeliverFrame(input);
    const framePayload = serializeFrame(frame);
    const frameBytes = new TextEncoder().encode(framePayload).byteLength;
    if (frameBytes > this.deliveryPolicy.maxFrameBytes) {
      throw new Error("Relay connector frame exceeds max allowed size");
    }

    return new Promise<boolean>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingDeliveries.delete(frame.id);
        reject(new Error("Relay connector acknowledgement timed out"));
      }, DEFAULT_RELAY_DELIVER_TIMEOUT_MS);

      this.pendingDeliveries.set(frame.id, {
        resolve,
        reject,
        timeoutHandle,
      });

      try {
        socket.send(framePayload);
      } catch (error) {
        clearTimeout(timeoutHandle);
        this.pendingDeliveries.delete(frame.id);
        reject(error);
      }
    });
  }
}
