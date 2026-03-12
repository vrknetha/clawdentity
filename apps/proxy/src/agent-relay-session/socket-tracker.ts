import { toHeartbeatFrame } from "./frames.js";

type RelaySocketTrackerOptions = {
  heartbeatAckTimeoutMs: number;
  staleCloseCode: number;
};

export class RelaySocketTracker {
  private readonly heartbeatAckSockets = new Map<string, WebSocket>();
  private readonly socketLastAckAtMs = new Map<WebSocket, number>();
  private readonly socketsPendingClose = new Set<WebSocket>();

  constructor(private readonly options: RelaySocketTrackerOptions) {}

  getActiveSockets(sockets: WebSocket[], nowMs: number): WebSocket[] {
    this.pruneSocketTracking(sockets);
    const activeSockets: WebSocket[] = [];

    for (const socket of sockets) {
      if (this.socketsPendingClose.has(socket)) {
        continue;
      }

      const lastAckAtMs = this.resolveSocketLastAckAtMs(socket, nowMs);
      if (nowMs - lastAckAtMs > this.options.heartbeatAckTimeoutMs) {
        this.closeSocket(
          socket,
          this.options.staleCloseCode,
          "heartbeat_ack_timeout",
        );
        continue;
      }

      activeSockets.push(socket);
    }

    return activeSockets;
  }

  touchSocketAck(socket: WebSocket, nowMs: number): void {
    if (this.socketsPendingClose.has(socket)) {
      return;
    }

    this.socketLastAckAtMs.set(socket, nowMs);
  }

  sendHeartbeatFrame(socket: WebSocket, nowMs: number): void {
    const heartbeatFrame = toHeartbeatFrame(nowMs);
    this.clearSocketHeartbeatAcks(socket);
    this.heartbeatAckSockets.set(heartbeatFrame.id, socket);

    try {
      socket.send(heartbeatFrame.payload);
    } catch {
      this.heartbeatAckSockets.delete(heartbeatFrame.id);
      this.closeSocket(
        socket,
        this.options.staleCloseCode,
        "heartbeat_send_failed",
      );
    }
  }

  handleHeartbeatAck(
    ackId: string,
    fallbackSocket: WebSocket,
    nowMs: number,
  ): void {
    const ackedSocket = this.heartbeatAckSockets.get(ackId);
    this.heartbeatAckSockets.delete(ackId);
    this.touchSocketAck(ackedSocket ?? fallbackSocket, nowMs);
  }

  closeSocket(socket: WebSocket, code: number, reason: string): void {
    this.socketsPendingClose.add(socket);
    this.removeSocketTracking(socket);
    try {
      socket.close(code, reason);
    } catch {
      // Ignore close errors for already-closed sockets.
    }
  }

  onSocketClosed(socket: WebSocket): void {
    this.removeSocketTracking(socket);
    this.socketsPendingClose.delete(socket);
  }

  private resolveSocketLastAckAtMs(socket: WebSocket, nowMs: number): number {
    const existing = this.socketLastAckAtMs.get(socket);
    if (existing !== undefined) {
      return existing;
    }

    this.socketLastAckAtMs.set(socket, nowMs);
    return nowMs;
  }

  private clearSocketHeartbeatAcks(socket: WebSocket): void {
    for (const [ackId, ackSocket] of this.heartbeatAckSockets) {
      if (ackSocket === socket) {
        this.heartbeatAckSockets.delete(ackId);
      }
    }
  }

  private removeSocketTracking(socket: WebSocket): void {
    this.socketLastAckAtMs.delete(socket);
    this.clearSocketHeartbeatAcks(socket);
  }

  private pruneSocketTracking(activeSockets: WebSocket[]): void {
    const activeSocketSet = new Set(activeSockets);

    for (const socket of this.socketLastAckAtMs.keys()) {
      if (!activeSocketSet.has(socket)) {
        this.socketLastAckAtMs.delete(socket);
      }
    }

    for (const socket of this.socketsPendingClose) {
      if (!activeSocketSet.has(socket)) {
        this.socketsPendingClose.delete(socket);
      }
    }

    for (const [ackId, socket] of this.heartbeatAckSockets.entries()) {
      if (!activeSocketSet.has(socket)) {
        this.heartbeatAckSockets.delete(ackId);
      }
    }
  }
}
