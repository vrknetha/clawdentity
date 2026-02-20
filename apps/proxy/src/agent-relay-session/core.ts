import {
  DEFAULT_RELAY_DELIVER_TIMEOUT_MS,
  parseFrame,
  serializeFrame,
} from "@clawdentity/connector";
import { generateUlid, RELAY_CONNECT_PATH } from "@clawdentity/protocol";
import { nowUtcMs, toIso } from "@clawdentity/sdk";
import { parseProxyConfig } from "../config.js";
import {
  CONNECTOR_AGENT_DID_HEADER,
  RELAY_HEARTBEAT_ACK_TIMEOUT_MS,
  RELAY_QUEUE_STORAGE_KEY,
  RELAY_RPC_DELIVER_PATH,
  RELAY_RPC_GET_RECEIPT_PATH,
  RELAY_RPC_RECORD_RECEIPT_PATH,
  RELAY_SOCKET_STALE_CLOSE_CODE,
  RELAY_SOCKET_SUPERSEDED_CLOSE_CODE,
} from "./constants.js";
import { RelayQueueFullError } from "./errors.js";
import {
  getWebSocketMessageBytes,
  toDeliverFrame,
  toHeartbeatAckFrame,
  toRelayDeliveryResult,
} from "./frames.js";
import {
  parseDeliveryInput,
  parseReceiptLookupInput,
  parseReceiptRecordInput,
} from "./parsers.js";
import { rejectPendingDeliveries } from "./pending-deliveries.js";
import { computeRetryDelayMs } from "./policy.js";
import {
  deleteQueuedReceipt,
  isQueuedDelivery,
  normalizeReceipts,
  pruneExpiredQueueState,
  upsertReceipt,
} from "./queue-state.js";
import { toErrorResponse } from "./rpc.js";
import { scheduleNextRelayAlarm } from "./scheduler.js";
import { RelaySocketTracker } from "./socket-tracker.js";
import type {
  DurableObjectStateLike,
  PendingDelivery,
  QueuedRelayDelivery,
  RelayDeliveryInput,
  RelayDeliveryPolicy,
  RelayDeliveryResult,
  RelayQueueState,
  RelayReceiptLookupInput,
  RelayReceiptLookupResult,
  RelayReceiptRecordInput,
} from "./types.js";

export class AgentRelaySession {
  private readonly deliveryPolicy: RelayDeliveryPolicy;
  private readonly pendingDeliveries = new Map<string, PendingDelivery>();
  private readonly socketTracker: RelaySocketTracker;
  private readonly state: DurableObjectStateLike;
  private inMemoryQueueState: RelayQueueState = {
    deliveries: [],
    receipts: {},
  };

  constructor(state: DurableObjectStateLike, env?: unknown) {
    this.state = state;
    const config = parseProxyConfig(env ?? {});
    this.deliveryPolicy = {
      maxFrameBytes: config.relayMaxFrameBytes,
      maxInFlightDeliveries: config.relayMaxInFlightDeliveries,
      queueMaxMessagesPerAgent: config.relayQueueMaxMessagesPerAgent,
      queueTtlMs: config.relayQueueTtlSeconds * 1000,
      retryInitialMs: config.relayRetryInitialMs,
      retryJitterRatio: config.relayRetryJitterRatio,
      retryMaxAttempts: config.relayRetryMaxAttempts,
      retryMaxMs: config.relayRetryMaxMs,
    };
    this.socketTracker = new RelaySocketTracker({
      heartbeatAckTimeoutMs: RELAY_HEARTBEAT_ACK_TIMEOUT_MS,
      staleCloseCode: RELAY_SOCKET_STALE_CLOSE_CODE,
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === RELAY_CONNECT_PATH) {
      return this.handleConnect(request);
    }

    if (request.method === "POST" && url.pathname === RELAY_RPC_DELIVER_PATH) {
      let input: RelayDeliveryInput;
      try {
        input = parseDeliveryInput(await request.json());
      } catch {
        return new Response("Invalid relay delivery input", { status: 400 });
      }

      try {
        const result = await this.deliverToConnector(input);
        return Response.json(result, { status: 202 });
      } catch (error) {
        if (error instanceof RelayQueueFullError) {
          return toErrorResponse({
            code: error.code,
            message: error.message,
            status: error.status,
          });
        }

        return new Response("Relay delivery failed", { status: 502 });
      }
    }

    if (
      request.method === "POST" &&
      url.pathname === RELAY_RPC_RECORD_RECEIPT_PATH
    ) {
      let input: RelayReceiptRecordInput;
      try {
        input = parseReceiptRecordInput(await request.json());
      } catch {
        return new Response("Invalid relay receipt input", { status: 400 });
      }

      await this.recordDeliveryReceipt(input);
      return Response.json({ accepted: true }, { status: 202 });
    }

    if (
      request.method === "POST" &&
      url.pathname === RELAY_RPC_GET_RECEIPT_PATH
    ) {
      let input: RelayReceiptLookupInput;
      try {
        input = parseReceiptLookupInput(await request.json());
      } catch {
        return new Response("Invalid relay receipt lookup input", {
          status: 400,
        });
      }

      const receipt = await this.getDeliveryReceipt(input);
      return Response.json(receipt, { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    const nowMs = nowUtcMs();
    const sockets = this.getActiveSockets(nowMs);

    if (sockets.length > 0) {
      for (const socket of sockets) {
        this.sendHeartbeatFrame(socket, nowMs);
      }
    }

    const queueState = await this.loadQueueState(nowMs);
    const queueMutated = await this.processQueueDeliveries(queueState, nowMs);
    if (queueMutated) {
      await this.saveQueueState(queueState);
    }

    await this.scheduleNextAlarm(queueState, nowMs);
  }

  async deliverToConnector(
    input: RelayDeliveryInput,
  ): Promise<RelayDeliveryResult> {
    const nowMs = nowUtcMs();
    const queueState = await this.loadQueueState(nowMs);
    const existingReceipt = queueState.receipts[input.requestId];

    if (
      existingReceipt !== undefined &&
      existingReceipt.expiresAtMs > nowMs &&
      existingReceipt.senderAgentDid === input.senderAgentDid &&
      existingReceipt.recipientAgentDid === input.recipientAgentDid
    ) {
      return toRelayDeliveryResult({
        deliveryId: existingReceipt.deliveryId,
        state: existingReceipt.state,
        connectedSockets: this.getActiveSockets(nowMs).length,
        queueDepth: queueState.deliveries.length,
      });
    }

    const sockets = this.getActiveSockets(nowMs);
    const deliveryId = generateUlid(nowMs);
    const deliveryTtlExpiresAtMs = nowMs + this.deliveryPolicy.queueTtlMs;
    let priorAttempts = 0;

    if (
      sockets.length > 0 &&
      this.pendingDeliveries.size < this.deliveryPolicy.maxInFlightDeliveries
    ) {
      priorAttempts = 1;
      try {
        const accepted = await this.sendDeliverFrame(sockets[0], input);
        if (accepted) {
          upsertReceipt(queueState, {
            requestId: input.requestId,
            deliveryId,
            state: "delivered",
            expiresAtMs: deliveryTtlExpiresAtMs,
            senderAgentDid: input.senderAgentDid,
            recipientAgentDid: input.recipientAgentDid,
            statusUpdatedAt: toIso(nowMs),
          });
          await this.saveQueueState(queueState);
          await this.scheduleNextAlarm(queueState, nowMs);

          return toRelayDeliveryResult({
            deliveryId,
            state: "delivered",
            connectedSockets: sockets.length,
            queueDepth: queueState.deliveries.length,
          });
        }
      } catch {
        // Fall through to durable queueing below.
      }
    }

    if (priorAttempts >= this.deliveryPolicy.retryMaxAttempts) {
      throw new Error("Relay delivery exhausted retry budget");
    }

    if (
      queueState.deliveries.length >=
      this.deliveryPolicy.queueMaxMessagesPerAgent
    ) {
      throw new RelayQueueFullError();
    }

    const queuedDelivery: QueuedRelayDelivery = {
      deliveryId,
      requestId: input.requestId,
      senderAgentDid: input.senderAgentDid,
      recipientAgentDid: input.recipientAgentDid,
      conversationId: input.conversationId,
      replyTo: input.replyTo,
      payload: input.payload,
      createdAtMs: nowMs,
      attemptCount: priorAttempts,
      expiresAtMs: deliveryTtlExpiresAtMs,
      nextAttemptAtMs:
        nowMs + computeRetryDelayMs(this.deliveryPolicy, priorAttempts),
    };

    queueState.deliveries.push(queuedDelivery);
    upsertReceipt(queueState, {
      requestId: queuedDelivery.requestId,
      deliveryId: queuedDelivery.deliveryId,
      state: "queued",
      expiresAtMs: queuedDelivery.expiresAtMs,
      senderAgentDid: queuedDelivery.senderAgentDid,
      recipientAgentDid: queuedDelivery.recipientAgentDid,
      statusUpdatedAt: toIso(nowMs),
    });

    await this.saveQueueState(queueState);
    await this.scheduleNextAlarm(queueState, nowMs);

    return toRelayDeliveryResult({
      deliveryId,
      state: "queued",
      connectedSockets: sockets.length,
      queueDepth: queueState.deliveries.length,
    });
  }

  async recordDeliveryReceipt(input: RelayReceiptRecordInput): Promise<void> {
    const nowMs = nowUtcMs();
    const queueState = await this.loadQueueState(nowMs);
    const existing = queueState.receipts[input.requestId];
    if (existing === undefined) {
      return;
    }

    if (
      existing.senderAgentDid !== input.senderAgentDid ||
      existing.recipientAgentDid !== input.recipientAgentDid
    ) {
      return;
    }

    existing.state = input.status;
    existing.reason = input.reason;
    existing.expiresAtMs = nowMs + this.deliveryPolicy.queueTtlMs;
    existing.statusUpdatedAt = toIso(nowMs);
    await this.saveQueueState(queueState);
    await this.scheduleNextAlarm(queueState, nowMs);
  }

  async getDeliveryReceipt(
    input: RelayReceiptLookupInput,
  ): Promise<RelayReceiptLookupResult> {
    const nowMs = nowUtcMs();
    const queueState = await this.loadQueueState(nowMs);
    const existing = queueState.receipts[input.requestId];
    if (
      existing === undefined ||
      existing.senderAgentDid !== input.senderAgentDid
    ) {
      return { found: false };
    }

    return {
      found: true,
      receipt: existing,
    };
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const frameBytes = getWebSocketMessageBytes(message);
    if (frameBytes > this.deliveryPolicy.maxFrameBytes) {
      this.closeSocket(ws, 1009, "frame_too_large");
      await this.scheduleFromStorage();
      return;
    }

    const nowMs = nowUtcMs();
    const frameResult = (() => {
      try {
        return parseFrame(message);
      } catch {
        return null;
      }
    })();

    if (frameResult === null) {
      await this.scheduleFromStorage();
      return;
    }

    const frame = frameResult;

    if (frame.type === "heartbeat") {
      this.socketTracker.touchSocketAck(ws, nowMs);
      ws.send(toHeartbeatAckFrame(frame.id));
      await this.scheduleFromStorage();
      return;
    }

    if (frame.type === "deliver_ack") {
      this.socketTracker.touchSocketAck(ws, nowMs);
      const pending = this.pendingDeliveries.get(frame.ackId);
      if (pending) {
        clearTimeout(pending.timeoutHandle);
        this.pendingDeliveries.delete(frame.ackId);
        pending.resolve(frame.accepted);
      }
      await this.scheduleFromStorage();
      return;
    }

    if (frame.type === "heartbeat_ack") {
      this.socketTracker.handleHeartbeatAck(frame.ackId, ws, nowMs);
      await this.scheduleFromStorage();
      return;
    }

    await this.scheduleFromStorage();
  }

  async webSocketClose(
    ws?: WebSocket,
    code?: number,
    _reason?: string,
    wasClean?: boolean,
  ): Promise<void> {
    if (ws !== undefined) {
      this.socketTracker.onSocketClosed(ws);
    }

    const gracefulClose = code === 1000 && (wasClean ?? true);
    if (!gracefulClose && this.state.getWebSockets().length === 0) {
      rejectPendingDeliveries(
        this.pendingDeliveries,
        new Error("Connector socket closed"),
      );
    }

    await this.scheduleFromStorage();
  }

  async webSocketError(ws?: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011, "connector_socket_error", false);
  }

  private async handleConnect(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get("upgrade");
    if (upgradeHeader?.toLowerCase() !== "websocket") {
      return new Response("Expected websocket upgrade", { status: 426 });
    }

    const connectorAgentDid =
      request.headers.get(CONNECTOR_AGENT_DID_HEADER)?.trim() ?? "";
    if (connectorAgentDid.length === 0) {
      return new Response("Missing connector agent DID", { status: 400 });
    }

    const nowMs = nowUtcMs();
    const activeSockets = this.getActiveSockets(nowMs);
    for (const socket of activeSockets) {
      this.closeSocket(
        socket,
        RELAY_SOCKET_SUPERSEDED_CLOSE_CODE,
        "superseded_by_new_connection",
      );
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.state.acceptWebSocket(server, [connectorAgentDid]);
    this.socketTracker.touchSocketAck(server, nowMs);
    void this.drainQueueOnReconnect();

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private async loadQueueState(nowMs: number): Promise<RelayQueueState> {
    const fromStorage = this.state.storage.get
      ? await this.state.storage.get(RELAY_QUEUE_STORAGE_KEY)
      : this.inMemoryQueueState;
    const rawState =
      typeof fromStorage === "object" && fromStorage !== null
        ? (fromStorage as Partial<RelayQueueState>)
        : undefined;

    const queueState: RelayQueueState = {
      deliveries: Array.isArray(rawState?.deliveries)
        ? rawState.deliveries.filter((entry) => isQueuedDelivery(entry))
        : [],
      receipts: normalizeReceipts(rawState?.receipts),
    };

    const pruned = pruneExpiredQueueState(queueState, nowMs);
    if (pruned) {
      await this.saveQueueState(queueState);
    }

    return queueState;
  }

  private async saveQueueState(queueState: RelayQueueState): Promise<void> {
    const serialized: RelayQueueState = {
      deliveries: [...queueState.deliveries],
      receipts: { ...queueState.receipts },
    };

    if (this.state.storage.put) {
      await this.state.storage.put(RELAY_QUEUE_STORAGE_KEY, serialized);
      return;
    }

    this.inMemoryQueueState = serialized;
  }

  private async processQueueDeliveries(
    queueState: RelayQueueState,
    nowMs: number,
  ): Promise<boolean> {
    if (queueState.deliveries.length === 0) {
      return false;
    }

    const sockets = this.getActiveSockets(nowMs);
    if (sockets.length === 0) {
      let mutated = false;
      for (const delivery of queueState.deliveries) {
        if (delivery.nextAttemptAtMs <= nowMs) {
          delivery.nextAttemptAtMs =
            nowMs +
            computeRetryDelayMs(this.deliveryPolicy, delivery.attemptCount);
          mutated = true;
        }
      }

      return mutated;
    }

    queueState.deliveries.sort((left, right) => {
      if (left.nextAttemptAtMs !== right.nextAttemptAtMs) {
        return left.nextAttemptAtMs - right.nextAttemptAtMs;
      }

      return left.createdAtMs - right.createdAtMs;
    });

    let mutated = false;
    const socket = sockets[0];

    for (let index = 0; index < queueState.deliveries.length; ) {
      if (
        this.pendingDeliveries.size >= this.deliveryPolicy.maxInFlightDeliveries
      ) {
        break;
      }

      const delivery = queueState.deliveries[index];

      if (delivery.expiresAtMs <= nowMs) {
        queueState.deliveries.splice(index, 1);
        deleteQueuedReceipt(
          queueState,
          delivery.requestId,
          delivery.deliveryId,
        );
        mutated = true;
        continue;
      }

      if (delivery.attemptCount >= this.deliveryPolicy.retryMaxAttempts) {
        queueState.deliveries.splice(index, 1);
        deleteQueuedReceipt(
          queueState,
          delivery.requestId,
          delivery.deliveryId,
        );
        mutated = true;
        continue;
      }

      if (delivery.nextAttemptAtMs > nowMs) {
        index += 1;
        continue;
      }

      let accepted = false;
      let deliveryError = false;
      try {
        accepted = await this.sendDeliverFrame(socket, {
          requestId: delivery.requestId,
          senderAgentDid: delivery.senderAgentDid,
          recipientAgentDid: delivery.recipientAgentDid,
          conversationId: delivery.conversationId,
          replyTo: delivery.replyTo,
          payload: delivery.payload,
        });
      } catch {
        deliveryError = true;
      }

      if (accepted) {
        queueState.deliveries.splice(index, 1);
        upsertReceipt(queueState, {
          requestId: delivery.requestId,
          deliveryId: delivery.deliveryId,
          state: "delivered",
          expiresAtMs: nowMs + this.deliveryPolicy.queueTtlMs,
          senderAgentDid: delivery.senderAgentDid,
          recipientAgentDid: delivery.recipientAgentDid,
          statusUpdatedAt: toIso(nowMs),
        });
        mutated = true;
        continue;
      }

      const nextAttemptCount = delivery.attemptCount + 1;
      if (nextAttemptCount >= this.deliveryPolicy.retryMaxAttempts) {
        queueState.deliveries.splice(index, 1);
        deleteQueuedReceipt(
          queueState,
          delivery.requestId,
          delivery.deliveryId,
        );
        mutated = true;
        continue;
      }

      delivery.attemptCount = nextAttemptCount;
      delivery.nextAttemptAtMs =
        nowMs + computeRetryDelayMs(this.deliveryPolicy, delivery.attemptCount);
      mutated = true;
      index += 1;

      if (deliveryError) {
        for (
          let remaining = index;
          remaining < queueState.deliveries.length;
          remaining += 1
        ) {
          if (queueState.deliveries[remaining].nextAttemptAtMs <= nowMs) {
            queueState.deliveries[remaining].nextAttemptAtMs =
              nowMs +
              computeRetryDelayMs(
                this.deliveryPolicy,
                queueState.deliveries[remaining].attemptCount,
              );
          }
        }
        break;
      }
    }

    return mutated;
  }
  private async sendDeliverFrame(
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

  private getActiveSockets(nowMs: number): WebSocket[] {
    return this.socketTracker.getActiveSockets(
      this.state.getWebSockets(),
      nowMs,
    );
  }

  private sendHeartbeatFrame(socket: WebSocket, nowMs: number): void {
    this.socketTracker.sendHeartbeatFrame(socket, nowMs);
  }

  private closeSocket(socket: WebSocket, code: number, reason: string): void {
    this.socketTracker.closeSocket(socket, code, reason);
  }

  private async drainQueueOnReconnect(): Promise<void> {
    const nowMs = nowUtcMs();
    const queueState = await this.loadQueueState(nowMs);
    let queueMutated = false;

    for (const delivery of queueState.deliveries) {
      if (delivery.nextAttemptAtMs > nowMs) {
        delivery.nextAttemptAtMs = nowMs;
        queueMutated = true;
      }
    }

    if (await this.processQueueDeliveries(queueState, nowMs)) {
      queueMutated = true;
    }

    if (queueMutated) {
      await this.saveQueueState(queueState);
    }

    await this.scheduleNextAlarm(queueState, nowMs);
  }

  private async scheduleFromStorage(): Promise<void> {
    const nowMs = nowUtcMs();
    const queueState = await this.loadQueueState(nowMs);
    await this.scheduleNextAlarm(queueState, nowMs);
  }

  private async scheduleNextAlarm(
    queueState: RelayQueueState,
    nowMs: number,
  ): Promise<void> {
    await scheduleNextRelayAlarm({
      storage: this.state.storage,
      queueState,
      nowMs,
      hasActiveSockets: this.getActiveSockets(nowMs).length > 0,
    });
  }
}
