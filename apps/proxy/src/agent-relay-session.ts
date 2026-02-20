import {
  CONNECTOR_FRAME_VERSION,
  DEFAULT_RELAY_DELIVER_TIMEOUT_MS,
  type DeliverFrame,
  type HeartbeatAckFrame,
  parseFrame,
  serializeFrame,
} from "@clawdentity/connector";
import { generateUlid, RELAY_CONNECT_PATH } from "@clawdentity/protocol";
import { parseProxyConfig } from "./config.js";

const CONNECTOR_AGENT_DID_HEADER = "x-claw-connector-agent-did";
const RELAY_RPC_DELIVER_PATH = "/rpc/deliver-to-connector";
const RELAY_HEARTBEAT_INTERVAL_MS = 30_000;
const RELAY_HEARTBEAT_ACK_TIMEOUT_MS = 60_000;
const RELAY_QUEUE_STORAGE_KEY = "relay:delivery-queue";
const RELAY_SOCKET_SUPERSEDED_CLOSE_CODE = 1000;
const RELAY_SOCKET_STALE_CLOSE_CODE = 1011;

type DurableObjectStorageLike = {
  deleteAlarm?: () => Promise<void> | void;
  get?: (key: string) => Promise<unknown> | unknown;
  put?: (key: string, value: unknown) => Promise<void> | void;
  setAlarm: (scheduledTime: number | Date) => Promise<void> | void;
};

type DurableObjectStateLike = {
  acceptWebSocket: (socket: WebSocket, tags?: string[]) => void;
  getWebSockets: () => WebSocket[];
  storage: DurableObjectStorageLike;
};

export type RelayDeliveryInput = {
  payload: unknown;
  recipientAgentDid: string;
  requestId: string;
  senderAgentDid: string;
};

export type RelayDeliveryState = "delivered" | "queued";

export type RelayDeliveryResult = {
  connectedSockets: number;
  delivered: boolean;
  deliveryId: string;
  queueDepth: number;
  queued: boolean;
  state: RelayDeliveryState;
};

export class RelaySessionDeliveryError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(input: { code: string; message: string; status: number }) {
    super(input.message);
    this.name = "RelaySessionDeliveryError";
    this.code = input.code;
    this.status = input.status;
  }
}

class RelayQueueFullError extends Error {
  readonly code = "PROXY_RELAY_QUEUE_FULL";
  readonly status = 507;

  constructor() {
    super("Target relay queue is full");
    this.name = "RelayQueueFullError";
  }
}

export type AgentRelaySessionStub = {
  deliverToConnector?: (
    input: RelayDeliveryInput,
  ) => Promise<RelayDeliveryResult>;
  fetch: (request: Request) => Promise<Response>;
};

export type AgentRelaySessionNamespace = {
  get: (id: DurableObjectId) => AgentRelaySessionStub;
  idFromName: (name: string) => DurableObjectId;
};

type PendingDelivery = {
  reject: (error: unknown) => void;
  resolve: (accepted: boolean) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
};

type QueuedRelayDelivery = {
  attemptCount: number;
  createdAtMs: number;
  deliveryId: string;
  expiresAtMs: number;
  nextAttemptAtMs: number;
  payload: unknown;
  recipientAgentDid: string;
  requestId: string;
  senderAgentDid: string;
};

type RelayDeliveryReceipt = {
  deliveryId: string;
  expiresAtMs: number;
  requestId: string;
  state: RelayDeliveryState;
};

type RelayQueueState = {
  deliveries: QueuedRelayDelivery[];
  receipts: Record<string, RelayDeliveryReceipt>;
};

type RelayDeliveryPolicy = {
  queueMaxMessagesPerAgent: number;
  queueTtlMs: number;
  retryInitialMs: number;
  retryJitterRatio: number;
  retryMaxAttempts: number;
  retryMaxMs: number;
};

function toHeartbeatFrame(nowMs: number): { id: string; payload: string } {
  const id = generateUlid(nowMs);
  return {
    id,
    payload: serializeFrame({
      v: CONNECTOR_FRAME_VERSION,
      type: "heartbeat",
      id,
      ts: new Date(nowMs).toISOString(),
    }),
  };
}

function toHeartbeatAckFrame(ackId: string): string {
  const nowMs = Date.now();
  const ackFrame: HeartbeatAckFrame = {
    v: CONNECTOR_FRAME_VERSION,
    type: "heartbeat_ack",
    id: generateUlid(nowMs),
    ts: new Date(nowMs).toISOString(),
    ackId,
  };

  return serializeFrame(ackFrame);
}

function toDeliverFrame(input: RelayDeliveryInput): DeliverFrame {
  return {
    v: CONNECTOR_FRAME_VERSION,
    type: "deliver",
    id: generateUlid(Date.now()),
    ts: new Date().toISOString(),
    fromAgentDid: input.senderAgentDid,
    toAgentDid: input.recipientAgentDid,
    payload: input.payload,
  };
}

function parseDeliveryInput(value: unknown): RelayDeliveryInput {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Relay delivery input must be an object");
  }

  const input = value as Partial<RelayDeliveryInput>;
  if (
    typeof input.requestId !== "string" ||
    typeof input.senderAgentDid !== "string" ||
    typeof input.recipientAgentDid !== "string"
  ) {
    throw new TypeError("Relay delivery input is invalid");
  }

  return {
    requestId: input.requestId,
    senderAgentDid: input.senderAgentDid,
    recipientAgentDid: input.recipientAgentDid,
    payload: input.payload,
  };
}

function toRelayDeliveryResult(input: {
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

function toErrorResponse(input: {
  code: string;
  message: string;
  status: number;
}): Response {
  return Response.json(
    {
      error: {
        code: input.code,
        message: input.message,
      },
    },
    { status: input.status },
  );
}

export async function deliverToRelaySession(
  relaySession: AgentRelaySessionStub,
  input: RelayDeliveryInput,
): Promise<RelayDeliveryResult> {
  const response = await relaySession.fetch(
    new Request(`https://agent-relay-session${RELAY_RPC_DELIVER_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    }),
  );

  if (!response.ok) {
    let code = "PROXY_RELAY_DELIVERY_FAILED";
    let message = "Relay session delivery RPC failed";
    try {
      const body = (await response.json()) as {
        error?: { code?: unknown; message?: unknown };
      };
      if (typeof body.error?.code === "string") {
        code = body.error.code;
      }
      if (typeof body.error?.message === "string") {
        message = body.error.message;
      }
    } catch {
      // Ignore parse failures and keep defaults.
    }

    throw new RelaySessionDeliveryError({
      code,
      message,
      status: response.status,
    });
  }

  return (await response.json()) as RelayDeliveryResult;
}

export class AgentRelaySession {
  private readonly deliveryPolicy: RelayDeliveryPolicy;
  private readonly heartbeatAckSockets = new Map<string, WebSocket>();
  private readonly pendingDeliveries = new Map<string, PendingDelivery>();
  private readonly socketLastAckAtMs = new Map<WebSocket, number>();
  private readonly socketsPendingClose = new Set<WebSocket>();
  private readonly state: DurableObjectStateLike;
  private inMemoryQueueState: RelayQueueState = {
    deliveries: [],
    receipts: {},
  };

  constructor(state: DurableObjectStateLike, env?: unknown) {
    this.state = state;
    const config = parseProxyConfig(env ?? {});
    this.deliveryPolicy = {
      queueMaxMessagesPerAgent: config.relayQueueMaxMessagesPerAgent,
      queueTtlMs: config.relayQueueTtlSeconds * 1000,
      retryInitialMs: config.relayRetryInitialMs,
      retryJitterRatio: config.relayRetryJitterRatio,
      retryMaxAttempts: config.relayRetryMaxAttempts,
      retryMaxMs: config.relayRetryMaxMs,
    };
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

    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    const nowMs = Date.now();
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
    const nowMs = Date.now();
    const queueState = await this.loadQueueState(nowMs);
    const existingReceipt = queueState.receipts[input.requestId];

    if (existingReceipt !== undefined && existingReceipt.expiresAtMs > nowMs) {
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

    if (sockets.length > 0) {
      priorAttempts = 1;
      try {
        const accepted = await this.sendDeliverFrame(sockets[0], input);
        if (accepted) {
          this.upsertReceipt(queueState, {
            requestId: input.requestId,
            deliveryId,
            state: "delivered",
            expiresAtMs: deliveryTtlExpiresAtMs,
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
      payload: input.payload,
      createdAtMs: nowMs,
      attemptCount: priorAttempts,
      expiresAtMs: deliveryTtlExpiresAtMs,
      nextAttemptAtMs: nowMs + this.computeRetryDelayMs(priorAttempts),
    };

    queueState.deliveries.push(queuedDelivery);
    this.upsertReceipt(queueState, {
      requestId: queuedDelivery.requestId,
      deliveryId: queuedDelivery.deliveryId,
      state: "queued",
      expiresAtMs: queuedDelivery.expiresAtMs,
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

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const nowMs = Date.now();
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
      this.touchSocketAck(ws, nowMs);
      ws.send(toHeartbeatAckFrame(frame.id));
      await this.scheduleFromStorage();
      return;
    }

    if (frame.type === "deliver_ack") {
      this.touchSocketAck(ws, nowMs);
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
      const ackedSocket = this.heartbeatAckSockets.get(frame.ackId);
      this.heartbeatAckSockets.delete(frame.ackId);
      this.touchSocketAck(ackedSocket ?? ws, nowMs);
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
      this.removeSocketTracking(ws);
      this.socketsPendingClose.delete(ws);
    }

    const gracefulClose = code === 1000 && (wasClean ?? true);
    if (!gracefulClose && this.state.getWebSockets().length === 0) {
      this.rejectPendingDeliveries(new Error("Connector socket closed"));
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

    const nowMs = Date.now();
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
    this.touchSocketAck(server, nowMs);
    await this.drainQueueOnReconnect();

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
        ? rawState.deliveries.filter((entry) => this.isQueuedDelivery(entry))
        : [],
      receipts: this.normalizeReceipts(rawState?.receipts),
    };

    const pruned = this.pruneExpiredQueueState(queueState, nowMs);
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

  private isQueuedDelivery(value: unknown): value is QueuedRelayDelivery {
    if (typeof value !== "object" || value === null) {
      return false;
    }

    const candidate = value as Partial<QueuedRelayDelivery>;
    return (
      typeof candidate.deliveryId === "string" &&
      typeof candidate.requestId === "string" &&
      typeof candidate.senderAgentDid === "string" &&
      typeof candidate.recipientAgentDid === "string" &&
      typeof candidate.createdAtMs === "number" &&
      Number.isFinite(candidate.createdAtMs) &&
      typeof candidate.attemptCount === "number" &&
      Number.isInteger(candidate.attemptCount) &&
      candidate.attemptCount >= 0 &&
      typeof candidate.expiresAtMs === "number" &&
      Number.isFinite(candidate.expiresAtMs) &&
      typeof candidate.nextAttemptAtMs === "number" &&
      Number.isFinite(candidate.nextAttemptAtMs)
    );
  }

  private normalizeReceipts(
    input: unknown,
  ): Record<string, RelayDeliveryReceipt> {
    if (typeof input !== "object" || input === null) {
      return {};
    }

    const normalized: Record<string, RelayDeliveryReceipt> = {};
    for (const [key, value] of Object.entries(
      input as Record<string, unknown>,
    )) {
      if (typeof value !== "object" || value === null) {
        continue;
      }

      const receipt = value as Partial<RelayDeliveryReceipt>;
      if (
        typeof receipt.requestId !== "string" ||
        receipt.requestId !== key ||
        typeof receipt.deliveryId !== "string" ||
        typeof receipt.expiresAtMs !== "number" ||
        !Number.isFinite(receipt.expiresAtMs) ||
        (receipt.state !== "queued" && receipt.state !== "delivered")
      ) {
        continue;
      }

      normalized[key] = {
        requestId: receipt.requestId,
        deliveryId: receipt.deliveryId,
        expiresAtMs: receipt.expiresAtMs,
        state: receipt.state,
      };
    }

    return normalized;
  }

  private pruneExpiredQueueState(
    queueState: RelayQueueState,
    nowMs: number,
  ): boolean {
    let mutated = false;

    const retainedDeliveries: QueuedRelayDelivery[] = [];
    for (const delivery of queueState.deliveries) {
      if (delivery.expiresAtMs <= nowMs) {
        this.deleteQueuedReceipt(
          queueState,
          delivery.requestId,
          delivery.deliveryId,
        );
        mutated = true;
        continue;
      }

      retainedDeliveries.push(delivery);
    }

    if (retainedDeliveries.length !== queueState.deliveries.length) {
      queueState.deliveries = retainedDeliveries;
      mutated = true;
    }

    for (const [requestId, receipt] of Object.entries(queueState.receipts)) {
      if (receipt.expiresAtMs <= nowMs) {
        delete queueState.receipts[requestId];
        mutated = true;
      }
    }

    return mutated;
  }

  private deleteQueuedReceipt(
    queueState: RelayQueueState,
    requestId: string,
    deliveryId: string,
  ): void {
    const receipt = queueState.receipts[requestId];
    if (receipt === undefined) {
      return;
    }

    if (receipt.deliveryId !== deliveryId || receipt.state !== "queued") {
      return;
    }

    delete queueState.receipts[requestId];
  }

  private upsertReceipt(
    queueState: RelayQueueState,
    receipt: RelayDeliveryReceipt,
  ): void {
    queueState.receipts[receipt.requestId] = receipt;
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
            nowMs + this.computeRetryDelayMs(delivery.attemptCount);
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
      const delivery = queueState.deliveries[index];

      if (delivery.expiresAtMs <= nowMs) {
        queueState.deliveries.splice(index, 1);
        this.deleteQueuedReceipt(
          queueState,
          delivery.requestId,
          delivery.deliveryId,
        );
        mutated = true;
        continue;
      }

      if (delivery.attemptCount >= this.deliveryPolicy.retryMaxAttempts) {
        queueState.deliveries.splice(index, 1);
        this.deleteQueuedReceipt(
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
          payload: delivery.payload,
        });
      } catch {
        deliveryError = true;
      }

      if (accepted) {
        queueState.deliveries.splice(index, 1);
        this.upsertReceipt(queueState, {
          requestId: delivery.requestId,
          deliveryId: delivery.deliveryId,
          state: "delivered",
          expiresAtMs: nowMs + this.deliveryPolicy.queueTtlMs,
        });
        mutated = true;
        continue;
      }

      const nextAttemptCount = delivery.attemptCount + 1;
      if (nextAttemptCount >= this.deliveryPolicy.retryMaxAttempts) {
        queueState.deliveries.splice(index, 1);
        this.deleteQueuedReceipt(
          queueState,
          delivery.requestId,
          delivery.deliveryId,
        );
        mutated = true;
        continue;
      }

      delivery.attemptCount = nextAttemptCount;
      delivery.nextAttemptAtMs =
        nowMs + this.computeRetryDelayMs(delivery.attemptCount);
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
              this.computeRetryDelayMs(
                queueState.deliveries[remaining].attemptCount,
              );
          }
        }
        break;
      }
    }

    return mutated;
  }

  private computeRetryDelayMs(priorAttempts: number): number {
    const exponent = Math.max(0, priorAttempts - 1);
    const baseDelay = Math.min(
      this.deliveryPolicy.retryMaxMs,
      this.deliveryPolicy.retryInitialMs * 2 ** exponent,
    );

    if (this.deliveryPolicy.retryJitterRatio <= 0) {
      return baseDelay;
    }

    const jitterSpan = baseDelay * this.deliveryPolicy.retryJitterRatio;
    const lowerBound = Math.max(1, Math.floor(baseDelay - jitterSpan));
    const upperBound = Math.ceil(baseDelay + jitterSpan);
    const sample = lowerBound + Math.random() * (upperBound - lowerBound);
    return Math.min(this.deliveryPolicy.retryMaxMs, Math.floor(sample));
  }

  private async sendDeliverFrame(
    socket: WebSocket,
    input: RelayDeliveryInput,
  ): Promise<boolean> {
    const frame = toDeliverFrame(input);
    const framePayload = serializeFrame(frame);

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

  private rejectPendingDeliveries(error: Error): void {
    for (const [deliveryId, pending] of this.pendingDeliveries) {
      clearTimeout(pending.timeoutHandle);
      pending.reject(error);
      this.pendingDeliveries.delete(deliveryId);
    }
  }

  private getActiveSockets(nowMs: number): WebSocket[] {
    const sockets = this.state.getWebSockets();
    this.pruneSocketTracking(sockets);
    const activeSockets: WebSocket[] = [];

    for (const socket of sockets) {
      if (this.socketsPendingClose.has(socket)) {
        continue;
      }

      const lastAckAtMs = this.resolveSocketLastAckAtMs(socket, nowMs);
      if (nowMs - lastAckAtMs > RELAY_HEARTBEAT_ACK_TIMEOUT_MS) {
        this.closeSocket(
          socket,
          RELAY_SOCKET_STALE_CLOSE_CODE,
          "heartbeat_ack_timeout",
        );
        continue;
      }

      activeSockets.push(socket);
    }

    return activeSockets;
  }

  private resolveSocketLastAckAtMs(socket: WebSocket, nowMs: number): number {
    const existing = this.socketLastAckAtMs.get(socket);
    if (existing !== undefined) {
      return existing;
    }

    this.socketLastAckAtMs.set(socket, nowMs);
    return nowMs;
  }

  private touchSocketAck(socket: WebSocket, nowMs: number): void {
    this.socketsPendingClose.delete(socket);
    this.socketLastAckAtMs.set(socket, nowMs);
  }

  private sendHeartbeatFrame(socket: WebSocket, nowMs: number): void {
    const heartbeatFrame = toHeartbeatFrame(nowMs);
    this.clearSocketHeartbeatAcks(socket);
    this.heartbeatAckSockets.set(heartbeatFrame.id, socket);

    try {
      socket.send(heartbeatFrame.payload);
    } catch {
      this.heartbeatAckSockets.delete(heartbeatFrame.id);
      this.closeSocket(
        socket,
        RELAY_SOCKET_STALE_CLOSE_CODE,
        "heartbeat_send_failed",
      );
    }
  }

  private clearSocketHeartbeatAcks(socket: WebSocket): void {
    for (const [ackId, ackSocket] of this.heartbeatAckSockets) {
      if (ackSocket === socket) {
        this.heartbeatAckSockets.delete(ackId);
      }
    }
  }

  private closeSocket(socket: WebSocket, code: number, reason: string): void {
    this.socketsPendingClose.add(socket);
    this.removeSocketTracking(socket);
    try {
      socket.close(code, reason);
    } catch {
      // Ignore close errors for already-closed sockets.
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

  private async drainQueueOnReconnect(): Promise<void> {
    const nowMs = Date.now();
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
    const nowMs = Date.now();
    const queueState = await this.loadQueueState(nowMs);
    await this.scheduleNextAlarm(queueState, nowMs);
  }

  private async scheduleNextAlarm(
    queueState: RelayQueueState,
    nowMs: number,
  ): Promise<void> {
    const candidates: number[] = [];

    const queueWakeAtMs = this.findNextQueueWakeMs(queueState, nowMs);
    if (queueWakeAtMs !== undefined) {
      candidates.push(queueWakeAtMs);
    }

    if (this.getActiveSockets(nowMs).length > 0) {
      candidates.push(nowMs + RELAY_HEARTBEAT_INTERVAL_MS);
    }

    if (candidates.length === 0) {
      await this.state.storage.deleteAlarm?.();
      return;
    }

    await this.state.storage.setAlarm(Math.min(...candidates));
  }

  private findNextQueueWakeMs(
    queueState: RelayQueueState,
    nowMs: number,
  ): number | undefined {
    let earliest: number | undefined;

    for (const delivery of queueState.deliveries) {
      const candidate = Math.max(nowMs + 1, delivery.nextAttemptAtMs);
      if (earliest === undefined || candidate < earliest) {
        earliest = candidate;
      }
    }

    return earliest;
  }
}
