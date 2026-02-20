import { generateUlid } from "@clawdentity/protocol";
import { createLogger, type Logger } from "@clawdentity/sdk";
import {
  CONNECTOR_FRAME_VERSION,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_HEARTBEAT_ACK_TIMEOUT_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_OPENCLAW_DELIVER_MAX_ATTEMPTS,
  DEFAULT_OPENCLAW_DELIVER_RETRY_BACKOFF_FACTOR,
  DEFAULT_OPENCLAW_DELIVER_RETRY_BUDGET_MS,
  DEFAULT_OPENCLAW_DELIVER_RETRY_INITIAL_DELAY_MS,
  DEFAULT_OPENCLAW_DELIVER_RETRY_MAX_DELAY_MS,
  DEFAULT_OPENCLAW_DELIVER_TIMEOUT_MS,
  DEFAULT_OPENCLAW_HOOK_PATH,
  DEFAULT_RECONNECT_BACKOFF_FACTOR,
  DEFAULT_RECONNECT_JITTER_RATIO,
  DEFAULT_RECONNECT_MAX_DELAY_MS,
  DEFAULT_RECONNECT_MIN_DELAY_MS,
  WS_READY_STATE_OPEN,
} from "./constants.js";
import {
  type ConnectorFrame,
  type DeliverAckFrame,
  type DeliverFrame,
  type EnqueueFrame,
  enqueueFrameSchema,
  type HeartbeatAckFrame,
  type HeartbeatFrame,
  parseFrame,
  serializeFrame,
} from "./frames.js";

type ConnectorWebSocketEventType =
  | "open"
  | "message"
  | "close"
  | "error"
  | "unexpected-response";
type ConnectorWebSocketListener = (event: unknown) => void;
const WS_READY_STATE_CONNECTING = 0;

export type ConnectorWebSocket = {
  readonly readyState: number;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  addEventListener: (
    type: ConnectorWebSocketEventType,
    listener: ConnectorWebSocketListener,
  ) => void;
};

export type ConnectorClientHooks = {
  onConnected?: () => void;
  onDisconnected?: (event: {
    code: number;
    reason: string;
    wasClean: boolean;
  }) => void;
  onAuthUpgradeRejected?: (event: {
    status: number;
    immediateRetry: boolean;
  }) => void | Promise<void>;
  onFrame?: (frame: ConnectorFrame) => void;
  onDeliverSucceeded?: (frame: DeliverFrame) => void;
  onDeliverFailed?: (frame: DeliverFrame, error: unknown) => void;
};

export type ConnectorClientOptions = {
  connectorUrl: string;
  connectionHeaders?: Record<string, string>;
  connectionHeadersProvider?:
    | (() => Record<string, string> | Promise<Record<string, string>>)
    | undefined;
  openclawBaseUrl: string;
  openclawHookToken?: string;
  openclawHookPath?: string;
  connectTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatAckTimeoutMs?: number;
  reconnectMinDelayMs?: number;
  reconnectMaxDelayMs?: number;
  reconnectBackoffFactor?: number;
  reconnectJitterRatio?: number;
  openclawDeliverTimeoutMs?: number;
  openclawDeliverMaxAttempts?: number;
  openclawDeliverRetryInitialDelayMs?: number;
  openclawDeliverRetryMaxDelayMs?: number;
  openclawDeliverRetryBackoffFactor?: number;
  openclawDeliverRetryBudgetMs?: number;
  webSocketFactory?: (
    url: string,
    headers: Record<string, string>,
  ) => ConnectorWebSocket;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  hooks?: ConnectorClientHooks;
  inboundDeliverHandler?:
    | ((frame: DeliverFrame) => Promise<{ accepted: boolean; reason?: string }>)
    | undefined;
  now?: () => number;
  random?: () => number;
  ulidFactory?: (time?: number) => string;
};

export type ConnectorOutboundEnqueueInput = {
  toAgentDid: string;
  payload: unknown;
  conversationId?: string;
  replyTo?: string;
};

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function resolveWebSocketFactory(
  webSocketFactory: ConnectorClientOptions["webSocketFactory"],
): (url: string, headers: Record<string, string>) => ConnectorWebSocket {
  if (webSocketFactory !== undefined) {
    return webSocketFactory;
  }

  if (typeof WebSocket !== "function") {
    throw new Error("WebSocket implementation is required");
  }

  return (_url: string, headers: Record<string, string>) => {
    if (Object.keys(headers).length > 0) {
      throw new Error(
        "Connection headers require a custom webSocketFactory implementation",
      );
    }

    return new WebSocket(_url) as ConnectorWebSocket;
  };
}

function toOpenclawHookUrl(baseUrl: string, hookPath: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const normalizedHookPath = hookPath.startsWith("/")
    ? hookPath.slice(1)
    : hookPath;
  return new URL(normalizedHookPath, normalizedBase).toString();
}

function sanitizeErrorReason(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Unknown delivery error";
  }

  return error.message.trim().slice(0, 200) || "Unknown delivery error";
}

class LocalOpenclawDeliveryError extends Error {
  readonly retryable: boolean;

  constructor(input: { message: string; retryable: boolean }) {
    super(input.message);
    this.name = "LocalOpenclawDeliveryError";
    this.retryable = input.retryable;
  }
}

function isRetryableOpenclawDeliveryError(error: unknown): boolean {
  return (
    error instanceof LocalOpenclawDeliveryError && error.retryable === true
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readMessageEventData(event: unknown): unknown {
  if (!isObject(event)) {
    return undefined;
  }

  return event.data;
}

function readCloseEvent(event: unknown): {
  code: number;
  reason: string;
  wasClean: boolean;
} {
  if (!isObject(event)) {
    return {
      code: 1006,
      reason: "",
      wasClean: false,
    };
  }

  return {
    code: typeof event.code === "number" ? event.code : 1006,
    reason: typeof event.reason === "string" ? event.reason : "",
    wasClean: typeof event.wasClean === "boolean" ? event.wasClean : false,
  };
}

function readUnexpectedResponseStatus(event: unknown): number | undefined {
  if (!isObject(event)) {
    return undefined;
  }

  if (typeof event.status === "number") {
    return event.status;
  }

  if (typeof event.statusCode === "number") {
    return event.statusCode;
  }

  const response = event.response;
  if (isObject(response)) {
    if (typeof response.status === "number") {
      return response.status;
    }
    if (typeof response.statusCode === "number") {
      return response.statusCode;
    }
  }

  return undefined;
}

function readErrorEventReason(event: unknown): string {
  if (!isObject(event) || !("error" in event)) {
    return "WebSocket error";
  }

  return sanitizeErrorReason(event.error);
}

function normalizeConnectionHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  if (headers === undefined) {
    return {};
  }

  const normalized: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.trim();
    const value = rawValue.trim();
    if (key.length === 0 || value.length === 0) {
      continue;
    }
    normalized[key] = value;
  }

  return normalized;
}

export class ConnectorClient {
  private readonly connectorUrl: string;
  private readonly connectionHeaders: Record<string, string>;
  private readonly connectionHeadersProvider:
    | (() => Record<string, string> | Promise<Record<string, string>>)
    | undefined;
  private readonly openclawHookUrl: string;
  private readonly openclawHookToken?: string;
  private readonly connectTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatAckTimeoutMs: number;
  private readonly reconnectMinDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly reconnectBackoffFactor: number;
  private readonly reconnectJitterRatio: number;
  private readonly openclawDeliverTimeoutMs: number;
  private readonly openclawDeliverMaxAttempts: number;
  private readonly openclawDeliverRetryInitialDelayMs: number;
  private readonly openclawDeliverRetryMaxDelayMs: number;
  private readonly openclawDeliverRetryBackoffFactor: number;
  private readonly openclawDeliverRetryBudgetMs: number;
  private readonly webSocketFactory: (
    url: string,
    headers: Record<string, string>,
  ) => ConnectorWebSocket;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger;
  private readonly hooks: ConnectorClientHooks;
  private readonly inboundDeliverHandler:
    | ((frame: DeliverFrame) => Promise<{ accepted: boolean; reason?: string }>)
    | undefined;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly ulidFactory: (time?: number) => string;

  private socket: ConnectorWebSocket | undefined;
  private reconnectTimeout: ReturnType<typeof setTimeout> | undefined;
  private connectTimeout: ReturnType<typeof setTimeout> | undefined;
  private heartbeatInterval: ReturnType<typeof setInterval> | undefined;
  private heartbeatAckTimeout: ReturnType<typeof setTimeout> | undefined;
  private readonly pendingHeartbeatAcks = new Map<string, number>();
  private reconnectAttempt = 0;
  private authUpgradeImmediateRetryUsed = false;
  private started = false;
  private readonly outboundQueue: EnqueueFrame[] = [];

  constructor(options: ConnectorClientOptions) {
    this.connectorUrl = options.connectorUrl;
    this.connectionHeaders = normalizeConnectionHeaders(
      options.connectionHeaders,
    );
    this.connectionHeadersProvider = options.connectionHeadersProvider;
    this.openclawHookToken = options.openclawHookToken;
    this.connectTimeoutMs = Math.max(
      0,
      Math.floor(options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS),
    );
    this.heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatAckTimeoutMs = Math.max(
      0,
      Math.floor(
        options.heartbeatAckTimeoutMs ?? DEFAULT_HEARTBEAT_ACK_TIMEOUT_MS,
      ),
    );
    this.reconnectMinDelayMs =
      options.reconnectMinDelayMs ?? DEFAULT_RECONNECT_MIN_DELAY_MS;
    this.reconnectMaxDelayMs =
      options.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
    this.reconnectBackoffFactor =
      options.reconnectBackoffFactor ?? DEFAULT_RECONNECT_BACKOFF_FACTOR;
    this.reconnectJitterRatio =
      options.reconnectJitterRatio ?? DEFAULT_RECONNECT_JITTER_RATIO;
    this.openclawDeliverTimeoutMs =
      options.openclawDeliverTimeoutMs ?? DEFAULT_OPENCLAW_DELIVER_TIMEOUT_MS;
    this.openclawDeliverMaxAttempts = Math.max(
      1,
      Math.floor(
        options.openclawDeliverMaxAttempts ??
          DEFAULT_OPENCLAW_DELIVER_MAX_ATTEMPTS,
      ),
    );
    this.openclawDeliverRetryInitialDelayMs = Math.max(
      0,
      Math.floor(
        options.openclawDeliverRetryInitialDelayMs ??
          DEFAULT_OPENCLAW_DELIVER_RETRY_INITIAL_DELAY_MS,
      ),
    );
    this.openclawDeliverRetryMaxDelayMs = Math.max(
      this.openclawDeliverRetryInitialDelayMs,
      Math.floor(
        options.openclawDeliverRetryMaxDelayMs ??
          DEFAULT_OPENCLAW_DELIVER_RETRY_MAX_DELAY_MS,
      ),
    );
    this.openclawDeliverRetryBackoffFactor = Math.max(
      1,
      options.openclawDeliverRetryBackoffFactor ??
        DEFAULT_OPENCLAW_DELIVER_RETRY_BACKOFF_FACTOR,
    );
    this.openclawDeliverRetryBudgetMs = Math.max(
      this.openclawDeliverTimeoutMs,
      Math.floor(
        options.openclawDeliverRetryBudgetMs ??
          DEFAULT_OPENCLAW_DELIVER_RETRY_BUDGET_MS,
      ),
    );
    this.webSocketFactory = resolveWebSocketFactory(options.webSocketFactory);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger =
      options.logger ??
      createLogger({ service: "connector", module: "client" });
    this.hooks = options.hooks ?? {};
    this.inboundDeliverHandler = options.inboundDeliverHandler;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.ulidFactory = options.ulidFactory ?? generateUlid;

    this.openclawHookUrl = toOpenclawHookUrl(
      options.openclawBaseUrl,
      options.openclawHookPath ?? DEFAULT_OPENCLAW_HOOK_PATH,
    );
  }

  connect(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    void this.connectSocket();
  }

  disconnect(): void {
    this.started = false;
    this.clearReconnectTimeout();
    this.clearSocketState();

    if (this.socket !== undefined) {
      const socket = this.socket;
      this.socket = undefined;
      this.closeSocketQuietly(socket, 1000, "client disconnect");
    }
  }

  isConnected(): boolean {
    return this.socket?.readyState === WS_READY_STATE_OPEN;
  }

  getQueuedOutboundCount(): number {
    return this.outboundQueue.length;
  }

  enqueueOutbound(input: ConnectorOutboundEnqueueInput): EnqueueFrame {
    const frame = enqueueFrameSchema.parse({
      v: CONNECTOR_FRAME_VERSION,
      type: "enqueue",
      id: this.makeFrameId(),
      ts: this.makeTimestamp(),
      toAgentDid: input.toAgentDid,
      payload: input.payload,
      conversationId: input.conversationId,
      replyTo: input.replyTo,
    });

    this.outboundQueue.push(frame);
    this.flushOutboundQueue();
    return frame;
  }

  private async connectSocket(): Promise<void> {
    this.clearReconnectTimeout();

    let connectionHeaders = this.connectionHeaders;
    if (this.connectionHeadersProvider) {
      try {
        connectionHeaders = normalizeConnectionHeaders(
          await this.connectionHeadersProvider(),
        );
      } catch (error) {
        this.logger.warn("connector.websocket.create_failed", {
          reason: sanitizeErrorReason(error),
        });
        this.scheduleReconnect();
        return;
      }
    }

    if (!this.started) {
      return;
    }

    try {
      this.socket = this.webSocketFactory(this.connectorUrl, connectionHeaders);
    } catch (error) {
      this.logger.warn("connector.websocket.create_failed", {
        reason: sanitizeErrorReason(error),
      });
      this.scheduleReconnect();
      return;
    }

    const socket = this.socket;
    this.startConnectTimeout(socket);

    socket.addEventListener("open", () => {
      if (this.socket !== socket) {
        return;
      }

      this.clearConnectTimeout();
      this.clearHeartbeatTracking();
      this.reconnectAttempt = 0;
      this.authUpgradeImmediateRetryUsed = false;
      this.logger.info("connector.websocket.connected", {
        url: this.connectorUrl,
      });
      this.startHeartbeatInterval();
      this.flushOutboundQueue();
      this.hooks.onConnected?.();
    });

    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) {
        return;
      }

      void this.handleIncomingMessage(readMessageEventData(event));
    });

    socket.addEventListener("close", (event) => {
      if (!this.detachSocket(socket)) {
        return;
      }

      const closeEvent = readCloseEvent(event);

      this.logger.warn("connector.websocket.closed", {
        closeCode: closeEvent.code,
        reason: closeEvent.reason,
        wasClean: closeEvent.wasClean,
      });

      this.hooks.onDisconnected?.({
        code: closeEvent.code,
        reason: closeEvent.reason,
        wasClean: closeEvent.wasClean,
      });

      if (this.started) {
        this.scheduleReconnect();
      }
    });

    socket.addEventListener("error", (event) => {
      if (this.socket !== socket) {
        return;
      }

      const readyState = socket.readyState;
      const shouldForceReconnect =
        readyState !== WS_READY_STATE_OPEN &&
        readyState !== WS_READY_STATE_CONNECTING;
      if (!shouldForceReconnect) {
        this.logger.warn("connector.websocket.error", {
          url: this.connectorUrl,
          reason: readErrorEventReason(event),
          readyState,
        });
        return;
      }

      if (!this.detachSocket(socket)) {
        return;
      }

      const reason = readErrorEventReason(event);
      this.logger.warn("connector.websocket.error", {
        url: this.connectorUrl,
        reason,
      });
      this.closeSocketQuietly(socket, 1011, "websocket error");

      this.hooks.onDisconnected?.({
        code: 1006,
        reason,
        wasClean: false,
      });

      if (this.started) {
        this.scheduleReconnect();
      }
    });

    socket.addEventListener("unexpected-response", (event) => {
      void this.handleUnexpectedResponse(socket, event);
    });
  }

  private scheduleReconnect(options?: {
    delayMs?: number;
    incrementAttempt?: boolean;
  }): void {
    if (!this.started) {
      return;
    }

    this.clearReconnectTimeout();

    let delayMs: number;
    if (options?.delayMs !== undefined) {
      delayMs = Math.max(0, Math.floor(options.delayMs));
    } else {
      const exponentialDelay =
        this.reconnectMinDelayMs *
        this.reconnectBackoffFactor ** this.reconnectAttempt;
      const boundedDelay = Math.min(exponentialDelay, this.reconnectMaxDelayMs);
      const jitterRange = boundedDelay * this.reconnectJitterRatio;
      const jitterOffset =
        jitterRange === 0 ? 0 : (this.random() * 2 - 1) * jitterRange;
      delayMs = Math.max(0, Math.floor(boundedDelay + jitterOffset));
    }

    if (options?.incrementAttempt ?? true) {
      this.reconnectAttempt += 1;
    }

    this.reconnectTimeout = setTimeout(() => {
      void this.connectSocket();
    }, delayMs);
  }

  private clearReconnectTimeout(): void {
    if (this.reconnectTimeout !== undefined) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = undefined;
    }
  }

  private startConnectTimeout(socket: ConnectorWebSocket): void {
    this.clearConnectTimeout();

    if (this.connectTimeoutMs <= 0) {
      return;
    }

    this.connectTimeout = setTimeout(() => {
      if (!this.detachSocket(socket)) {
        return;
      }

      this.logger.warn("connector.websocket.connect_timeout", {
        timeoutMs: this.connectTimeoutMs,
        url: this.connectorUrl,
      });
      this.closeSocketQuietly(socket, 1000, "connect timeout");
      this.hooks.onDisconnected?.({
        code: 1006,
        reason: "WebSocket connect timed out",
        wasClean: false,
      });
      if (this.started) {
        this.scheduleReconnect();
      }
    }, this.connectTimeoutMs);
  }

  private clearConnectTimeout(): void {
    if (this.connectTimeout !== undefined) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = undefined;
    }
  }

  private clearSocketState(): void {
    this.clearConnectTimeout();
    this.clearHeartbeatTracking();
  }

  private clearHeartbeatTracking(): void {
    if (this.heartbeatInterval !== undefined) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
    if (this.heartbeatAckTimeout !== undefined) {
      clearTimeout(this.heartbeatAckTimeout);
      this.heartbeatAckTimeout = undefined;
    }
    this.pendingHeartbeatAcks.clear();
  }

  private detachSocket(socket: ConnectorWebSocket): boolean {
    if (this.socket !== socket) {
      return false;
    }

    this.socket = undefined;
    this.clearSocketState();
    return true;
  }

  private closeSocketQuietly(
    socket: ConnectorWebSocket,
    code?: number,
    reason?: string,
  ): void {
    try {
      socket.close(code, reason);
    } catch (error) {
      this.logger.warn("connector.websocket.close_failed", {
        reason: sanitizeErrorReason(error),
      });
    }
  }

  private async handleUnexpectedResponse(
    socket: ConnectorWebSocket,
    event: unknown,
  ): Promise<void> {
    if (!this.detachSocket(socket)) {
      return;
    }

    const statusCode = readUnexpectedResponseStatus(event);
    const isAuthRejected = statusCode === 401;
    const immediateRetry =
      isAuthRejected && !this.authUpgradeImmediateRetryUsed;
    if (isAuthRejected) {
      this.authUpgradeImmediateRetryUsed = true;
      await this.invokeAuthUpgradeRejectedHook({
        status: 401,
        immediateRetry,
      });
    }

    const reason =
      statusCode === undefined
        ? "WebSocket upgrade rejected"
        : `WebSocket upgrade rejected with status ${statusCode}`;

    this.logger.warn("connector.websocket.unexpected_response", {
      statusCode,
      immediateRetry,
      url: this.connectorUrl,
    });
    this.closeSocketQuietly(socket, 1000, reason);
    this.hooks.onDisconnected?.({
      code: 1006,
      reason,
      wasClean: false,
    });

    if (this.started) {
      this.scheduleReconnect(
        immediateRetry ? { delayMs: 0, incrementAttempt: false } : undefined,
      );
    }
  }

  private async invokeAuthUpgradeRejectedHook(input: {
    status: number;
    immediateRetry: boolean;
  }): Promise<void> {
    if (this.hooks.onAuthUpgradeRejected === undefined) {
      return;
    }

    try {
      await this.hooks.onAuthUpgradeRejected(input);
    } catch (error) {
      this.logger.warn(
        "connector.websocket.auth_upgrade_rejected_hook_failed",
        {
          reason: sanitizeErrorReason(error),
        },
      );
    }
  }

  private startHeartbeatInterval(): void {
    this.clearHeartbeatTracking();

    if (this.heartbeatIntervalMs <= 0) {
      return;
    }

    this.heartbeatInterval = setInterval(() => {
      const frame: HeartbeatFrame = {
        v: CONNECTOR_FRAME_VERSION,
        type: "heartbeat",
        id: this.makeFrameId(),
        ts: this.makeTimestamp(),
      };

      if (this.sendFrame(frame)) {
        this.trackHeartbeatAck(frame.id);
      }
    }, this.heartbeatIntervalMs);
  }

  private trackHeartbeatAck(ackId: string): void {
    if (this.heartbeatAckTimeoutMs <= 0) {
      return;
    }

    this.pendingHeartbeatAcks.set(ackId, this.now());
    this.scheduleHeartbeatAckTimeoutCheck();
  }

  private handleHeartbeatAckFrame(frame: HeartbeatAckFrame): void {
    if (!this.pendingHeartbeatAcks.delete(frame.ackId)) {
      return;
    }

    this.scheduleHeartbeatAckTimeoutCheck();
  }

  private scheduleHeartbeatAckTimeoutCheck(): void {
    if (this.heartbeatAckTimeout !== undefined) {
      clearTimeout(this.heartbeatAckTimeout);
      this.heartbeatAckTimeout = undefined;
    }

    if (
      this.pendingHeartbeatAcks.size === 0 ||
      this.heartbeatAckTimeoutMs <= 0
    ) {
      return;
    }

    let oldestSentAt = Number.POSITIVE_INFINITY;
    for (const sentAt of this.pendingHeartbeatAcks.values()) {
      oldestSentAt = Math.min(oldestSentAt, sentAt);
    }

    const elapsedMs = this.now() - oldestSentAt;
    const delayMs = Math.max(0, this.heartbeatAckTimeoutMs - elapsedMs);
    this.heartbeatAckTimeout = setTimeout(() => {
      this.heartbeatAckTimeout = undefined;
      this.handleHeartbeatAckTimeout();
    }, delayMs);
  }

  private handleHeartbeatAckTimeout(): void {
    const pendingCount = this.pendingHeartbeatAcks.size;
    if (pendingCount === 0) {
      return;
    }

    let oldestSentAt = Number.POSITIVE_INFINITY;
    for (const sentAt of this.pendingHeartbeatAcks.values()) {
      oldestSentAt = Math.min(oldestSentAt, sentAt);
    }

    const nowMs = this.now();
    const oldestPendingAgeMs = nowMs - oldestSentAt;
    if (oldestPendingAgeMs < this.heartbeatAckTimeoutMs) {
      this.scheduleHeartbeatAckTimeoutCheck();
      return;
    }

    const socket = this.socket;
    if (socket === undefined || !this.detachSocket(socket)) {
      return;
    }

    this.logger.warn("connector.websocket.heartbeat_ack_timeout", {
      pendingCount,
      oldestPendingAgeMs,
      timeoutMs: this.heartbeatAckTimeoutMs,
    });
    this.closeSocketQuietly(socket, 1000, "heartbeat ack timeout");
    this.hooks.onDisconnected?.({
      code: 1006,
      reason: "Heartbeat acknowledgement timed out",
      wasClean: false,
    });

    if (this.started) {
      this.scheduleReconnect();
    }
  }

  private flushOutboundQueue(): void {
    if (!this.isConnected()) {
      return;
    }

    while (this.outboundQueue.length > 0 && this.isConnected()) {
      const nextFrame = this.outboundQueue[0];
      const sent = this.sendFrame(nextFrame);
      if (!sent) {
        return;
      }
      this.outboundQueue.shift();
    }
  }

  private sendFrame(frame: ConnectorFrame): boolean {
    const socket = this.socket;
    if (socket === undefined || socket.readyState !== WS_READY_STATE_OPEN) {
      return false;
    }

    const payload = serializeFrame(frame);

    try {
      socket.send(payload);
      return true;
    } catch (error) {
      this.logger.warn("connector.websocket.send_failed", {
        frameType: frame.type,
        reason: sanitizeErrorReason(error),
      });
      return false;
    }
  }

  private async handleIncomingMessage(rawFrame: unknown): Promise<void> {
    let frame: ConnectorFrame;

    try {
      frame = parseFrame(rawFrame);
    } catch (error) {
      this.logger.warn("connector.frame.parse_failed", {
        reason: sanitizeErrorReason(error),
      });
      return;
    }

    this.hooks.onFrame?.(frame);

    if (frame.type === "heartbeat") {
      this.handleHeartbeatFrame(frame);
      return;
    }

    if (frame.type === "heartbeat_ack") {
      this.handleHeartbeatAckFrame(frame);
      return;
    }

    if (frame.type === "deliver") {
      await this.handleDeliverFrame(frame);
      return;
    }
  }

  private handleHeartbeatFrame(frame: HeartbeatFrame): void {
    const ackFrame: HeartbeatAckFrame = {
      v: CONNECTOR_FRAME_VERSION,
      type: "heartbeat_ack",
      id: this.makeFrameId(),
      ts: this.makeTimestamp(),
      ackId: frame.id,
    };

    this.sendFrame(ackFrame);
  }

  private async handleDeliverFrame(frame: DeliverFrame): Promise<void> {
    if (this.inboundDeliverHandler !== undefined) {
      try {
        const result = await this.inboundDeliverHandler(frame);
        const ackFrame: DeliverAckFrame = {
          v: CONNECTOR_FRAME_VERSION,
          type: "deliver_ack",
          id: this.makeFrameId(),
          ts: this.makeTimestamp(),
          ackId: frame.id,
          accepted: result.accepted,
          reason: result.reason,
        };

        this.sendFrame(ackFrame);
        if (result.accepted) {
          this.hooks.onDeliverSucceeded?.(frame);
        } else {
          this.hooks.onDeliverFailed?.(
            frame,
            new Error(
              result.reason ??
                "Inbound delivery was rejected by runtime handler",
            ),
          );
        }
      } catch (error) {
        const ackFrame: DeliverAckFrame = {
          v: CONNECTOR_FRAME_VERSION,
          type: "deliver_ack",
          id: this.makeFrameId(),
          ts: this.makeTimestamp(),
          ackId: frame.id,
          accepted: false,
          reason: sanitizeErrorReason(error),
        };
        this.sendFrame(ackFrame);
        this.hooks.onDeliverFailed?.(frame, error);
      }
      return;
    }

    try {
      await this.deliverToLocalOpenclawWithRetry(frame);
      const ackFrame: DeliverAckFrame = {
        v: CONNECTOR_FRAME_VERSION,
        type: "deliver_ack",
        id: this.makeFrameId(),
        ts: this.makeTimestamp(),
        ackId: frame.id,
        accepted: true,
      };

      this.sendFrame(ackFrame);
      this.hooks.onDeliverSucceeded?.(frame);
    } catch (error) {
      const ackFrame: DeliverAckFrame = {
        v: CONNECTOR_FRAME_VERSION,
        type: "deliver_ack",
        id: this.makeFrameId(),
        ts: this.makeTimestamp(),
        ackId: frame.id,
        accepted: false,
        reason: sanitizeErrorReason(error),
      };

      this.sendFrame(ackFrame);
      this.hooks.onDeliverFailed?.(frame, error);
    }
  }

  private async deliverToLocalOpenclaw(frame: DeliverFrame): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.openclawDeliverTimeoutMs);

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-request-id": frame.id,
    };

    if (this.openclawHookToken !== undefined) {
      headers["x-openclaw-token"] = this.openclawHookToken;
    }

    try {
      const response = await this.fetchImpl(this.openclawHookUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(frame.payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new LocalOpenclawDeliveryError({
          message: `Local OpenClaw hook rejected payload with status ${response.status}`,
          retryable:
            response.status >= 500 ||
            response.status === 404 ||
            response.status === 429,
        });
      }
    } catch (error) {
      if (isAbortError(error)) {
        throw new LocalOpenclawDeliveryError({
          message: "Local OpenClaw hook request timed out",
          retryable: true,
        });
      }

      if (error instanceof LocalOpenclawDeliveryError) {
        throw error;
      }

      throw new LocalOpenclawDeliveryError({
        message: sanitizeErrorReason(error),
        retryable: true,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async deliverToLocalOpenclawWithRetry(
    frame: DeliverFrame,
  ): Promise<void> {
    const startedAt = this.now();
    let attempt = 1;
    let retryDelayMs = this.openclawDeliverRetryInitialDelayMs;

    while (true) {
      try {
        await this.deliverToLocalOpenclaw(frame);
        return;
      } catch (error) {
        const retryable = isRetryableOpenclawDeliveryError(error);
        const attemptsRemaining = attempt < this.openclawDeliverMaxAttempts;
        const elapsedMs = this.now() - startedAt;
        const hasBudgetForRetry =
          elapsedMs + retryDelayMs + this.openclawDeliverTimeoutMs <=
          this.openclawDeliverRetryBudgetMs;
        const shouldRetry =
          retryable && attemptsRemaining && hasBudgetForRetry && this.started;

        this.logger.warn("connector.openclaw.deliver_failed", {
          ackId: frame.id,
          attempt,
          retryable,
          shouldRetry,
          reason: sanitizeErrorReason(error),
        });

        if (!shouldRetry) {
          throw error;
        }

        await this.wait(retryDelayMs);
        retryDelayMs = Math.min(
          this.openclawDeliverRetryMaxDelayMs,
          Math.floor(retryDelayMs * this.openclawDeliverRetryBackoffFactor),
        );
        attempt += 1;
      }
    }
  }

  private async wait(delayMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs);
    });
  }

  private makeFrameId(): string {
    return this.ulidFactory(this.now());
  }

  private makeTimestamp(): string {
    return new Date(this.now()).toISOString();
  }
}
