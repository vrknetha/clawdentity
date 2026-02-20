import { parseFrame } from "@clawdentity/connector";
import { getWebSocketMessageBytes, toHeartbeatAckFrame } from "./frames.js";
import type { RelaySocketTracker } from "./socket-tracker.js";

type RelayWebSocketMessageInput = {
  ws: WebSocket;
  message: string | ArrayBuffer;
  maxFrameBytes: number;
  socketTracker: RelaySocketTracker;
  closeSocket: (socket: WebSocket, code: number, reason: string) => void;
  now: () => number;
  onDeliverAck: (ackId: string, accepted: boolean) => void;
  onSchedule: () => Promise<void>;
};

export async function handleRelayWebSocketMessage(
  input: RelayWebSocketMessageInput,
): Promise<void> {
  const frameBytes = getWebSocketMessageBytes(input.message);
  if (frameBytes > input.maxFrameBytes) {
    input.closeSocket(input.ws, 1009, "frame_too_large");
    await input.onSchedule();
    return;
  }

  const nowMs = input.now();
  const frameResult = (() => {
    try {
      return parseFrame(input.message);
    } catch {
      return null;
    }
  })();

  if (frameResult === null) {
    await input.onSchedule();
    return;
  }

  if (frameResult.type === "heartbeat") {
    input.socketTracker.touchSocketAck(input.ws, nowMs);
    input.ws.send(toHeartbeatAckFrame(frameResult.id));
    await input.onSchedule();
    return;
  }

  if (frameResult.type === "deliver_ack") {
    input.socketTracker.touchSocketAck(input.ws, nowMs);
    input.onDeliverAck(frameResult.ackId, frameResult.accepted);
    await input.onSchedule();
    return;
  }

  if (frameResult.type === "heartbeat_ack") {
    input.socketTracker.handleHeartbeatAck(frameResult.ackId, input.ws, nowMs);
    await input.onSchedule();
    return;
  }

  await input.onSchedule();
}

type RelayWebSocketCloseInput = {
  ws?: WebSocket;
  code?: number;
  wasClean?: boolean;
  socketTracker: RelaySocketTracker;
  getSocketCount: () => number;
  rejectPending: (error: Error) => void;
  onSchedule: () => Promise<void>;
};

export async function handleRelayWebSocketClose(
  input: RelayWebSocketCloseInput,
): Promise<void> {
  if (input.ws !== undefined) {
    input.socketTracker.onSocketClosed(input.ws);
  }

  const gracefulClose = input.code === 1000 && (input.wasClean ?? true);
  if (!gracefulClose && input.getSocketCount() === 0) {
    input.rejectPending(new Error("Connector socket closed"));
  }

  await input.onSchedule();
}

export async function handleRelayWebSocketError(input: {
  ws?: WebSocket;
  socketTracker: RelaySocketTracker;
  getSocketCount: () => number;
  rejectPending: (error: Error) => void;
  onSchedule: () => Promise<void>;
}): Promise<void> {
  await handleRelayWebSocketClose({
    ws: input.ws,
    code: 1011,
    wasClean: false,
    socketTracker: input.socketTracker,
    getSocketCount: input.getSocketCount,
    rejectPending: input.rejectPending,
    onSchedule: input.onSchedule,
  });
}
