import { generateUlid } from "@clawdentity/protocol";
import { createLogger, type Logger, toIso } from "@clawdentity/sdk";
import { LocalOpenclawDeliveryClient } from "./client/delivery.js";
import {
  ConnectorHeartbeatManager,
  type HeartbeatAckTimeoutEvent,
} from "./client/heartbeat.js";
import {
  normalizeConnectionHeaders,
  readCloseEvent,
  readErrorEventReason,
  readMessageEventData,
  readUnexpectedResponseStatus,
  resolveWebSocketFactory,
  sanitizeErrorReason,
  toOpenclawHookUrl,
  WS_READY_STATE_CONNECTING,
} from "./client/helpers.js";
import { handleInboundDeliverFrame } from "./client/inbound-delivery.js";
import { ConnectorOutboundQueueManager } from "./client/queue.js";
import { computeJitteredBackoffDelayMs } from "./client/retry.js";
import type {
  ConnectorClientHooks,
  ConnectorClientMetricsSnapshot,
  ConnectorClientOptions,
  ConnectorOutboundEnqueueInput,
  ConnectorOutboundQueuePersistence,
  ConnectorWebSocket,
} from "./client/types.js";
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
  type DeliverFrame,
  type EnqueueFrame,
  enqueueFrameSchema,
  type HeartbeatAckFrame,
  type HeartbeatFrame,
  parseFrame,
  serializeFrame,
} from "./frames.js";

export type {
  ConnectorClientHooks,
  ConnectorClientMetricsSnapshot,
  ConnectorClientOptions,
  ConnectorOutboundEnqueueInput,
  ConnectorOutboundQueuePersistence,
  ConnectorWebSocket,
} from "./client/types.js";

export class ConnectorClient {
  private readonly connectorUrl: string;
  private readonly connectionHeaders: Record<string, string>;
  private readonly connectionHeadersProvider:
    | (() => Record<string, string> | Promise<Record<string, string>>)
    | undefined;
  private readonly connectTimeoutMs: number;
  private readonly reconnectMinDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly reconnectBackoffFactor: number;
  private readonly reconnectJitterRatio: number;
  private readonly webSocketFactory: (
    url: string,
    headers: Record<string, string>,
  ) => ConnectorWebSocket;
  private readonly logger: Logger;
  private readonly hooks: ConnectorClientHooks;
  private readonly outboundQueuePersistence:
    | ConnectorOutboundQueuePersistence
    | undefined;
  private readonly inboundDeliverHandler:
    | ((frame: DeliverFrame) => Promise<{ accepted: boolean; reason?: string }>)
    | undefined;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly ulidFactory: (time?: number) => string;

  private readonly heartbeatManager: ConnectorHeartbeatManager;
  private readonly outboundQueue: ConnectorOutboundQueueManager;
  private readonly localOpenclawDelivery: LocalOpenclawDeliveryClient;

  private socket: ConnectorWebSocket | undefined;
  private reconnectTimeout: ReturnType<typeof setTimeout> | undefined;
  private connectTimeout: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;
  private reconnectCount = 0;
  private connectAttempts = 0;
  private connectedSinceMs: number | undefined;
  private accumulatedConnectedMs = 0;
  private lastConnectedAtIso: string | undefined;

  private inboundAckLatencySampleCount = 0;
  private inboundAckLatencyTotalMs = 0;
  private inboundAckLatencyMaxMs = 0;
  private inboundAckLatencyLastMs: number | undefined;

  private authUpgradeImmediateRetryUsed = false;
  private started = false;

  constructor(options: ConnectorClientOptions) {
    this.connectorUrl = options.connectorUrl;
    this.connectionHeaders = normalizeConnectionHeaders(
      options.connectionHeaders,
    );
    this.connectionHeadersProvider = options.connectionHeadersProvider;
    this.connectTimeoutMs = Math.max(
      0,
      Math.floor(options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS),
    );

    const heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    const heartbeatAckTimeoutMs = Math.max(
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

    const openclawDeliverTimeoutMs =
      options.openclawDeliverTimeoutMs ?? DEFAULT_OPENCLAW_DELIVER_TIMEOUT_MS;
    const openclawDeliverMaxAttempts = Math.max(
      1,
      Math.floor(
        options.openclawDeliverMaxAttempts ??
          DEFAULT_OPENCLAW_DELIVER_MAX_ATTEMPTS,
      ),
    );
    const openclawDeliverRetryInitialDelayMs = Math.max(
      0,
      Math.floor(
        options.openclawDeliverRetryInitialDelayMs ??
          DEFAULT_OPENCLAW_DELIVER_RETRY_INITIAL_DELAY_MS,
      ),
    );
    const openclawDeliverRetryMaxDelayMs = Math.max(
      openclawDeliverRetryInitialDelayMs,
      Math.floor(
        options.openclawDeliverRetryMaxDelayMs ??
          DEFAULT_OPENCLAW_DELIVER_RETRY_MAX_DELAY_MS,
      ),
    );
    const openclawDeliverRetryBackoffFactor = Math.max(
      1,
      options.openclawDeliverRetryBackoffFactor ??
        DEFAULT_OPENCLAW_DELIVER_RETRY_BACKOFF_FACTOR,
    );
    const openclawDeliverRetryBudgetMs = Math.max(
      openclawDeliverTimeoutMs,
      Math.floor(
        options.openclawDeliverRetryBudgetMs ??
          DEFAULT_OPENCLAW_DELIVER_RETRY_BUDGET_MS,
      ),
    );

    this.webSocketFactory = resolveWebSocketFactory(options.webSocketFactory);
    this.logger =
      options.logger ??
      createLogger({ service: "connector", module: "client" });
    this.hooks = options.hooks ?? {};
    this.outboundQueuePersistence = options.outboundQueuePersistence;
    this.inboundDeliverHandler = options.inboundDeliverHandler;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.ulidFactory = options.ulidFactory ?? generateUlid;

    this.heartbeatManager = new ConnectorHeartbeatManager({
      heartbeatIntervalMs,
      heartbeatAckTimeoutMs,
      now: this.now,
      onAckTimeout: (event) => {
        this.handleHeartbeatAckTimeout(event);
      },
    });

    this.outboundQueue = new ConnectorOutboundQueueManager({
      persistence: this.outboundQueuePersistence,
      logger: this.logger,
    });

    const openclawHookUrl = toOpenclawHookUrl(
      options.openclawBaseUrl,
      options.openclawHookPath ?? DEFAULT_OPENCLAW_HOOK_PATH,
    );

    this.localOpenclawDelivery = new LocalOpenclawDeliveryClient({
      fetchImpl: options.fetchImpl ?? fetch,
      openclawHookUrl,
      openclawHookToken: options.openclawHookToken,
      openclawDeliverTimeoutMs,
      openclawDeliverMaxAttempts,
      openclawDeliverRetryInitialDelayMs,
      openclawDeliverRetryMaxDelayMs,
      openclawDeliverRetryBackoffFactor,
      openclawDeliverRetryBudgetMs,
      now: this.now,
      logger: this.logger,
    });
  }

  connect(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    if (this.outboundQueuePersistence !== undefined) {
      void this.ensureOutboundQueueLoaded();
    }
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
    return this.outboundQueue.getDepth();
  }

  getMetricsSnapshot(): ConnectorClientMetricsSnapshot {
    const nowMs = this.now();
    const uptimeMs =
      this.accumulatedConnectedMs +
      (this.connectedSinceMs === undefined ? 0 : nowMs - this.connectedSinceMs);

    return {
      connection: {
        connectAttempts: this.connectAttempts,
        connected: this.isConnected(),
        reconnectCount: this.reconnectCount,
        uptimeMs: Math.max(0, uptimeMs),
        lastConnectedAt: this.lastConnectedAtIso,
      },
      heartbeat: this.heartbeatManager.getMetricsSnapshot(),
      inboundDelivery: {
        sampleCount: this.inboundAckLatencySampleCount,
        lastAckLatencyMs: this.inboundAckLatencyLastMs,
        maxAckLatencyMs:
          this.inboundAckLatencySampleCount > 0
            ? this.inboundAckLatencyMaxMs
            : undefined,
        avgAckLatencyMs:
          this.inboundAckLatencySampleCount > 0
            ? Math.floor(
                this.inboundAckLatencyTotalMs /
                  this.inboundAckLatencySampleCount,
              )
            : undefined,
      },
      outboundQueue: this.outboundQueue.getMetricsSnapshot(),
    };
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

    this.outboundQueue.enqueue(frame);
    this.flushOutboundQueue();
    return frame;
  }

  private async connectSocket(): Promise<void> {
    this.clearReconnectTimeout();
    this.connectAttempts += 1;

    if (this.outboundQueuePersistence !== undefined) {
      await this.ensureOutboundQueueLoaded();
    }

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
      this.reconnectAttempt = 0;
      this.authUpgradeImmediateRetryUsed = false;
      this.connectedSinceMs = this.now();
      this.lastConnectedAtIso = this.makeTimestamp();
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
      delayMs = computeJitteredBackoffDelayMs({
        minDelayMs: this.reconnectMinDelayMs,
        maxDelayMs: this.reconnectMaxDelayMs,
        backoffFactor: this.reconnectBackoffFactor,
        attempt: this.reconnectAttempt,
        jitterRatio: this.reconnectJitterRatio,
        random: this.random,
      });
    }

    if (options?.incrementAttempt ?? true) {
      this.reconnectAttempt += 1;
    }
    this.reconnectCount += 1;

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
    this.heartbeatManager.stop();
  }

  private detachSocket(socket: ConnectorWebSocket): boolean {
    if (this.socket !== socket) {
      return false;
    }

    this.socket = undefined;
    if (this.connectedSinceMs !== undefined) {
      this.accumulatedConnectedMs += Math.max(
        0,
        this.now() - this.connectedSinceMs,
      );
      this.connectedSinceMs = undefined;
    }
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
    this.heartbeatManager.start(() => {
      const frame: HeartbeatFrame = {
        v: CONNECTOR_FRAME_VERSION,
        type: "heartbeat",
        id: this.makeFrameId(),
        ts: this.makeTimestamp(),
      };

      return this.sendFrame(frame) ? frame.id : undefined;
    });
  }

  private handleHeartbeatAckTimeout(event: HeartbeatAckTimeoutEvent): void {
    const socket = this.socket;
    if (socket === undefined || !this.detachSocket(socket)) {
      return;
    }

    this.logger.warn("connector.websocket.heartbeat_ack_timeout", {
      pendingCount: event.pendingCount,
      oldestPendingAgeMs: event.oldestPendingAgeMs,
      timeoutMs: event.timeoutMs,
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
    this.outboundQueue.flush({
      isConnected: () => this.isConnected(),
      sendFrame: (frame) => this.sendFrame(frame),
    });
  }

  private async ensureOutboundQueueLoaded(): Promise<void> {
    await this.outboundQueue.ensureLoaded();
    this.flushOutboundQueue();
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
      this.heartbeatManager.handleHeartbeatAck(frame);
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
    await handleInboundDeliverFrame({
      frame,
      inboundDeliverHandler: this.inboundDeliverHandler,
      localOpenclawDelivery: this.localOpenclawDelivery,
      isStarted: () => this.started,
      hooks: this.hooks,
      now: this.now,
      makeFrameId: () => this.makeFrameId(),
      makeTimestamp: () => this.makeTimestamp(),
      sendDeliverAckFrame: (ackFrame) => {
        this.sendFrame(ackFrame);
      },
      recordAckLatency: (durationMs) => {
        this.recordInboundDeliveryAckLatency(durationMs);
      },
    });
  }

  private recordInboundDeliveryAckLatency(durationMs: number): void {
    const latencyMs = Math.max(0, Math.floor(durationMs));
    this.inboundAckLatencySampleCount += 1;
    this.inboundAckLatencyTotalMs += latencyMs;
    this.inboundAckLatencyMaxMs = Math.max(
      this.inboundAckLatencyMaxMs,
      latencyMs,
    );
    this.inboundAckLatencyLastMs = latencyMs;
  }

  private makeFrameId(): string {
    return this.ulidFactory(this.now());
  }

  private makeTimestamp(): string {
    return toIso(this.now());
  }
}
