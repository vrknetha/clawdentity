import { generateUlid } from "@clawdentity/protocol";
import { createLogger, type Logger, toIso } from "@clawdentity/sdk";
import { LocalOpenclawDeliveryClient } from "./client/delivery.js";
import {
  ConnectorHeartbeatManager,
  type HeartbeatAckTimeoutEvent,
} from "./client/heartbeat.js";
import {
  normalizeConnectionHeaders,
  readUnexpectedResponseStatus,
  resolveWebSocketFactory,
  sanitizeErrorReason,
  toOpenclawHookUrl,
} from "./client/helpers.js";
import { routeConnectorInboundMessage } from "./client/inbound-router.js";
import { ConnectorClientMetricsTracker } from "./client/metrics.js";
import {
  ensureConnectorOutboundQueueLoaded,
  flushConnectorOutboundQueue,
  sendConnectorFrame,
} from "./client/outbound-flush.js";
import { ConnectorOutboundQueueManager } from "./client/queue.js";
import { ConnectorReconnectScheduler } from "./client/reconnect-scheduler.js";
import { attachConnectorSocketEventListeners } from "./client/socket-events.js";
import {
  closeConnectorSocketQuietly,
  createConnectorSocketEventHandlers,
  resolveConnectorConnectionHeaders,
} from "./client/socket-session.js";
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
  type HeartbeatFrame,
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
  private readonly metricsTracker: ConnectorClientMetricsTracker;
  private readonly reconnectScheduler: ConnectorReconnectScheduler;

  private socket: ConnectorWebSocket | undefined;
  private connectTimeout: ReturnType<typeof setTimeout> | undefined;

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
    this.metricsTracker = new ConnectorClientMetricsTracker(this.now);
    this.reconnectScheduler = new ConnectorReconnectScheduler({
      minDelayMs: this.reconnectMinDelayMs,
      maxDelayMs: this.reconnectMaxDelayMs,
      backoffFactor: this.reconnectBackoffFactor,
      jitterRatio: this.reconnectJitterRatio,
      random: this.random,
      onSchedule: () => {
        this.metricsTracker.onReconnectScheduled();
      },
      onReconnect: () => {
        void this.connectSocket();
      },
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
      resolveInboundSenderProfile: options.resolveInboundSenderProfile,
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
    this.reconnectScheduler.clear();
    this.clearSocketState();

    if (this.socket !== undefined) {
      const socket = this.socket;
      this.socket = undefined;
      closeConnectorSocketQuietly({
        socket,
        code: 1000,
        reason: "client disconnect",
        logger: this.logger,
      });
    }
  }

  isConnected(): boolean {
    return this.socket?.readyState === WS_READY_STATE_OPEN;
  }

  getQueuedOutboundCount(): number {
    return this.outboundQueue.getDepth();
  }

  getMetricsSnapshot(): ConnectorClientMetricsSnapshot {
    return this.metricsTracker.getSnapshot({
      connected: this.isConnected(),
      heartbeat: this.heartbeatManager.getMetricsSnapshot(),
      outboundQueue: this.outboundQueue.getMetricsSnapshot(),
    });
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
    this.reconnectScheduler.clear();
    this.metricsTracker.onConnectAttempt();

    if (this.outboundQueuePersistence !== undefined) {
      await this.ensureOutboundQueueLoaded();
    }

    let connectionHeaders = this.connectionHeaders;
    if (this.connectionHeadersProvider !== undefined) {
      const resolvedHeaders = await resolveConnectorConnectionHeaders({
        baseHeaders: this.connectionHeaders,
        provider: this.connectionHeadersProvider,
        logger: this.logger,
      });
      if (resolvedHeaders === undefined) {
        this.scheduleReconnect();
        return;
      }

      connectionHeaders = resolvedHeaders;
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

    const socketHandlers = createConnectorSocketEventHandlers({
      socket,
      connectorUrl: this.connectorUrl,
      hooks: this.hooks,
      logger: this.logger,
      metricsTracker: this.metricsTracker,
      reconnectScheduler: this.reconnectScheduler,
      clearConnectTimeout: () => {
        this.clearConnectTimeout();
      },
      startHeartbeatInterval: () => {
        this.startHeartbeatInterval();
      },
      flushOutboundQueue: () => {
        this.flushOutboundQueue();
      },
      isCurrentSocket: (candidate) => this.socket === candidate,
      detachSocket: (candidate) => this.detachSocket(candidate),
      closeSocketQuietly: (candidate, code, reason) => {
        closeConnectorSocketQuietly({
          socket: candidate,
          code,
          reason,
          logger: this.logger,
        });
      },
      onIncomingMessage: async (rawFrame) => {
        await this.handleIncomingMessage(rawFrame);
      },
      onUnexpectedResponse: async (candidate, event) => {
        await this.handleUnexpectedResponse(candidate, event);
      },
      isStarted: () => this.started,
      scheduleReconnect: (options) => {
        this.scheduleReconnect(options);
      },
      makeTimestamp: () => this.makeTimestamp(),
      onConnected: () => {
        this.authUpgradeImmediateRetryUsed = false;
      },
    });

    attachConnectorSocketEventListeners(socket, socketHandlers);
  }

  private scheduleReconnect(options?: {
    delayMs?: number;
    incrementAttempt?: boolean;
  }): void {
    if (!this.started) {
      return;
    }

    this.reconnectScheduler.schedule(options);
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
      closeConnectorSocketQuietly({
        socket,
        code: 1000,
        reason: "connect timeout",
        logger: this.logger,
      });
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
    this.metricsTracker.onSocketDetached();
    this.clearSocketState();
    return true;
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
    closeConnectorSocketQuietly({
      socket,
      code: 1000,
      reason,
      logger: this.logger,
    });
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
    closeConnectorSocketQuietly({
      socket,
      code: 1000,
      reason: "heartbeat ack timeout",
      logger: this.logger,
    });
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
    flushConnectorOutboundQueue({
      queue: this.outboundQueue,
      isConnected: () => this.isConnected(),
      sendFrame: (frame) => this.sendFrame(frame),
    });
  }

  private async ensureOutboundQueueLoaded(): Promise<void> {
    await ensureConnectorOutboundQueueLoaded({
      queue: this.outboundQueue,
      flush: () => this.flushOutboundQueue(),
    });
  }

  private sendFrame(frame: ConnectorFrame): boolean {
    return sendConnectorFrame({
      socket: this.socket,
      frame,
      logger: this.logger,
    });
  }

  private async handleIncomingMessage(rawFrame: unknown): Promise<void> {
    await routeConnectorInboundMessage({
      rawFrame,
      logger: this.logger,
      hooks: this.hooks,
      heartbeatManager: this.heartbeatManager,
      inboundDeliverHandler: this.inboundDeliverHandler,
      localOpenclawDelivery: this.localOpenclawDelivery,
      isStarted: () => this.started,
      makeFrameId: () => this.makeFrameId(),
      makeTimestamp: () => this.makeTimestamp(),
      now: this.now,
      sendFrame: (frame) => this.sendFrame(frame),
      recordAckLatency: (durationMs) => {
        this.metricsTracker.recordInboundDeliveryAckLatency(durationMs);
      },
    });
  }

  private makeFrameId(): string {
    return this.ulidFactory(this.now());
  }

  private makeTimestamp(): string {
    return toIso(this.now());
  }
}
