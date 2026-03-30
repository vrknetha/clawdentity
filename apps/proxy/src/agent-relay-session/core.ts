import { generateUlid, RELAY_CONNECT_PATH } from "@clawdentity/protocol";
import { nowUtcMs, toIso } from "@clawdentity/sdk";
import { parseProxyConfig } from "../config.js";
import {
  type GroupTrustAuthorizer,
  resolveRegistryGroupTrustAuthorizer,
} from "../group-trust.js";
import type { ProxyTrustStore } from "../proxy-trust-store.js";
import { assertTrustedPair } from "../trust-policy.js";
import { resolveWorkerTrustStore } from "../trust-store-backend.js";
import {
  CONNECTOR_AGENT_DID_HEADER,
  RELAY_HEARTBEAT_ACK_TIMEOUT_MS,
  RELAY_RPC_DELIVER_PATH,
  RELAY_RPC_GET_RECEIPT_PATH,
  RELAY_RPC_RECORD_RECEIPT_PATH,
  RELAY_SOCKET_STALE_CLOSE_CODE,
  RELAY_SOCKET_SUPERSEDED_CLOSE_CODE,
} from "./constants.js";
import { RelayDeliveryTransport } from "./delivery.js";
import { RelayQueueFullError } from "./errors.js";
import {
  toReceiptFramePayload,
  toRelayDeliveryInputFromEnqueueFrame,
  toRelayDeliveryResult,
} from "./frames.js";
import {
  parseDeliveryInput,
  parseReceiptLookupInput,
  parseReceiptRecordInput,
} from "./parsers.js";
import { computeRetryDelayMs } from "./policy.js";
import { RelayQueueManager } from "./queue-manager.js";
import { upsertReceipt } from "./queue-state.js";
import { deliverToRelaySession, toErrorResponse } from "./rpc.js";
import { RelaySocketTracker } from "./socket-tracker.js";
import type {
  AgentRelaySessionNamespace,
  DurableObjectStateLike,
  QueuedRelayDelivery,
  RelayDeliveryInput,
  RelayDeliveryPolicy,
  RelayDeliveryResult,
  RelayReceiptLookupInput,
  RelayReceiptLookupResult,
  RelayReceiptRecordInput,
} from "./types.js";
import {
  handleRelayWebSocketClose,
  handleRelayWebSocketError,
  handleRelayWebSocketMessage,
} from "./websocket.js";

export class AgentRelaySession {
  private readonly deliveryPolicy: RelayDeliveryPolicy;
  private readonly relaySessionNamespace:
    | AgentRelaySessionNamespace
    | undefined;
  private readonly socketTracker: RelaySocketTracker;
  private readonly deliveryTransport: RelayDeliveryTransport;
  private readonly queueManager: RelayQueueManager;
  private readonly state: DurableObjectStateLike;
  private readonly trustStore: ProxyTrustStore | undefined;
  private readonly groupTrustAuthorizer: GroupTrustAuthorizer | undefined;
  private readonly socketAgentDidBySocket = new WeakMap<WebSocket, string>();

  constructor(
    state: DurableObjectStateLike,
    env?: unknown,
    dependencies?: {
      relaySessionNamespace?: AgentRelaySessionNamespace;
      groupTrustAuthorizer?: GroupTrustAuthorizer;
      trustStore?: ProxyTrustStore;
    },
  ) {
    this.state = state;
    const relayEnv = readRelaySessionEnv(env);
    const config = parseProxyConfig(relayEnv);
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
    this.relaySessionNamespace =
      dependencies?.relaySessionNamespace ?? relayEnv.AGENT_RELAY_SESSION;
    this.trustStore =
      dependencies?.trustStore ??
      resolveRelayTrustStore({
        environment: config.environment,
        trustStateNamespace: relayEnv.PROXY_TRUST_STATE,
      });
    this.groupTrustAuthorizer =
      dependencies?.groupTrustAuthorizer ??
      resolveRegistryGroupTrustAuthorizer({
        registryUrl: config.registryUrl,
        registryInternalServiceId: config.registryInternalServiceId,
        registryInternalServiceSecret: config.registryInternalServiceSecret,
      });
    this.socketTracker = new RelaySocketTracker({
      heartbeatAckTimeoutMs: RELAY_HEARTBEAT_ACK_TIMEOUT_MS,
      staleCloseCode: RELAY_SOCKET_STALE_CLOSE_CODE,
    });

    this.deliveryTransport = new RelayDeliveryTransport(this.deliveryPolicy);
    this.queueManager = new RelayQueueManager({
      state: this.state,
      deliveryPolicy: this.deliveryPolicy,
      getActiveSockets: (nowMs) => this.getActiveSockets(nowMs),
      getPendingDeliveriesCount: () => this.deliveryTransport.getPendingCount(),
      sendDeliverFrame: (socket, input) =>
        this.deliveryTransport.sendDeliverFrame(socket, input),
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

    const queueState = await this.queueManager.loadQueueState(nowMs);
    const queueMutated = await this.queueManager.processQueueDeliveries(
      queueState,
      nowMs,
    );
    if (queueMutated) {
      await this.queueManager.saveQueueState(queueState);
    }

    await this.queueManager.scheduleNextAlarm(queueState, nowMs);
  }

  async deliverToConnector(
    input: RelayDeliveryInput,
  ): Promise<RelayDeliveryResult> {
    const nowMs = nowUtcMs();
    const queueState = await this.queueManager.loadQueueState(nowMs);
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
      this.deliveryTransport.getPendingCount() <
        this.deliveryPolicy.maxInFlightDeliveries
    ) {
      priorAttempts = 1;
      try {
        const accepted = await this.deliveryTransport.sendDeliverFrame(
          sockets[0],
          input,
        );
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
          await this.queueManager.saveQueueState(queueState);
          await this.queueManager.scheduleNextAlarm(queueState, nowMs);

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
      deliverySource: input.deliverySource,
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

    await this.queueManager.saveQueueState(queueState);
    await this.queueManager.scheduleNextAlarm(queueState, nowMs);

    return toRelayDeliveryResult({
      deliveryId,
      state: "queued",
      connectedSockets: sockets.length,
      queueDepth: queueState.deliveries.length,
    });
  }

  async recordDeliveryReceipt(input: RelayReceiptRecordInput): Promise<void> {
    const nowMs = nowUtcMs();
    const queueState = await this.queueManager.loadQueueState(nowMs);
    const existing = queueState.receipts[input.requestId];
    if (
      existing !== undefined &&
      (existing.senderAgentDid !== input.senderAgentDid ||
        existing.recipientAgentDid !== input.recipientAgentDid)
    ) {
      return;
    }

    const previousState = existing?.state;
    const previousReason = existing?.reason;

    const receipt =
      existing ??
      ({
        deliveryId: generateUlid(nowMs),
        requestId: input.requestId,
        senderAgentDid: input.senderAgentDid,
        recipientAgentDid: input.recipientAgentDid,
      } as const);

    queueState.receipts[input.requestId] = {
      ...receipt,
      state: input.status,
      reason: input.reason,
      expiresAtMs: nowMs + this.deliveryPolicy.queueTtlMs,
      statusUpdatedAt: toIso(nowMs),
    };
    await this.queueManager.saveQueueState(queueState);
    await this.queueManager.scheduleNextAlarm(queueState, nowMs);

    if (previousState !== input.status || previousReason !== input.reason) {
      this.pushReceiptFrameToActiveSockets({
        nowMs,
        originalFrameId: input.requestId,
        reason: input.reason,
        status: input.status,
        toAgentDid: input.recipientAgentDid,
      });
    }
  }

  async getDeliveryReceipt(
    input: RelayReceiptLookupInput,
  ): Promise<RelayReceiptLookupResult> {
    const nowMs = nowUtcMs();
    const queueState = await this.queueManager.loadQueueState(nowMs);
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
    await handleRelayWebSocketMessage({
      ws,
      message,
      maxFrameBytes: this.deliveryPolicy.maxFrameBytes,
      socketTracker: this.socketTracker,
      closeSocket: (socket, code, reason) => {
        this.closeSocket(socket, code, reason);
      },
      now: nowUtcMs,
      onDeliverAck: (ackId, accepted) => {
        this.deliveryTransport.resolveDeliverAck(ackId, accepted);
      },
      onEnqueueFrame: async (socket, frame) => {
        return this.handleEnqueueFrame(socket, frame);
      },
      onSchedule: async () => {
        await this.queueManager.scheduleFromStorage(nowUtcMs());
      },
    });
  }

  async webSocketClose(
    ws?: WebSocket,
    code?: number,
    _reason?: string,
    wasClean?: boolean,
  ): Promise<void> {
    if (ws !== undefined) {
      this.forgetSocketAgentDid(ws);
    }
    await handleRelayWebSocketClose({
      ws,
      code,
      wasClean,
      socketTracker: this.socketTracker,
      getSocketCount: () => this.state.getWebSockets().length,
      rejectPending: (error) => {
        this.deliveryTransport.rejectPending(error);
      },
      onSchedule: async () => {
        await this.queueManager.scheduleFromStorage(nowUtcMs());
      },
    });
  }

  async webSocketError(ws?: WebSocket): Promise<void> {
    if (ws !== undefined) {
      this.forgetSocketAgentDid(ws);
    }
    await handleRelayWebSocketError({
      ws,
      socketTracker: this.socketTracker,
      getSocketCount: () => this.state.getWebSockets().length,
      rejectPending: (error) => {
        this.deliveryTransport.rejectPending(error);
      },
      onSchedule: async () => {
        await this.queueManager.scheduleFromStorage(nowUtcMs());
      },
    });
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
    this.rememberSocketAgentDid(server, connectorAgentDid);
    this.socketTracker.touchSocketAck(server, nowMs);
    void this.queueManager.drainQueueOnReconnect(nowMs);
    void this.drainReceiptFramesOnReconnect(nowMs);

    return new Response(null, {
      status: 101,
      webSocket: client,
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

  private async handleEnqueueFrame(
    socket: WebSocket,
    frame: Parameters<typeof toRelayDeliveryInputFromEnqueueFrame>[0]["frame"],
  ): Promise<{ accepted: boolean; reason?: string }> {
    const senderAgentDid = this.readSocketAgentDid(socket);
    if (senderAgentDid === undefined) {
      return {
        accepted: false,
        reason: "Relay sender identity is unavailable for this websocket",
      };
    }

    if (this.relaySessionNamespace === undefined) {
      return {
        accepted: false,
        reason: "Relay session namespace is unavailable",
      };
    }

    if (this.trustStore === undefined) {
      return {
        accepted: false,
        reason: "Relay trust state is unavailable",
      };
    }

    if (typeof frame.groupId === "string" && frame.groupId.trim().length > 0) {
      if (this.groupTrustAuthorizer === undefined) {
        return {
          accepted: false,
          reason: "Group membership verification is unavailable",
        };
      }

      try {
        await this.groupTrustAuthorizer({
          groupId: frame.groupId,
          senderAgentDid,
          recipientAgentDid: frame.toAgentDid,
        });
      } catch (error) {
        return {
          accepted: false,
          reason:
            error instanceof Error
              ? error.message
              : "Group membership verification failed",
        };
      }
    } else {
      try {
        await assertTrustedPair({
          trustStore: this.trustStore,
          initiatorAgentDid: senderAgentDid,
          responderAgentDid: frame.toAgentDid,
        });
      } catch (error) {
        return {
          accepted: false,
          reason:
            error instanceof Error
              ? error.message
              : "Relay pair is not trusted",
        };
      }
    }

    try {
      const recipientRelay = this.relaySessionNamespace.get(
        this.relaySessionNamespace.idFromName(frame.toAgentDid),
      );
      await deliverToRelaySession(
        recipientRelay,
        toRelayDeliveryInputFromEnqueueFrame({
          frame,
          senderAgentDid,
        }),
      );
      return { accepted: true };
    } catch (error) {
      return {
        accepted: false,
        reason: error instanceof Error ? error.message : "Relay enqueue failed",
      };
    }
  }

  private rememberSocketAgentDid(socket: WebSocket, agentDid: string): void {
    this.socketAgentDidBySocket.set(socket, agentDid);
    const attachableSocket = socket as WebSocket & {
      serializeAttachment?: (value: unknown) => void;
    };
    attachableSocket.serializeAttachment?.({ connectorAgentDid: agentDid });
  }

  private readSocketAgentDid(socket: WebSocket): string | undefined {
    const remembered = this.socketAgentDidBySocket.get(socket);
    if (remembered !== undefined) {
      return remembered;
    }

    const attachableSocket = socket as WebSocket & {
      deserializeAttachment?: () => unknown;
    };
    const attachment = attachableSocket.deserializeAttachment?.();
    if (
      typeof attachment === "object" &&
      attachment !== null &&
      typeof (attachment as { connectorAgentDid?: unknown })
        .connectorAgentDid === "string"
    ) {
      const agentDid = (attachment as { connectorAgentDid: string })
        .connectorAgentDid;
      this.socketAgentDidBySocket.set(socket, agentDid);
      return agentDid;
    }

    return undefined;
  }

  private forgetSocketAgentDid(socket: WebSocket): void {
    this.socketAgentDidBySocket.delete(socket);
  }

  private closeSocket(socket: WebSocket, code: number, reason: string): void {
    this.socketTracker.closeSocket(socket, code, reason);
  }

  private pushReceiptFrameToActiveSockets(input: {
    nowMs: number;
    originalFrameId: string;
    reason?: string;
    status: "processed_by_openclaw" | "dead_lettered";
    toAgentDid: string;
  }): void {
    const payload = toReceiptFramePayload({
      nowMs: input.nowMs,
      originalFrameId: input.originalFrameId,
      reason: input.reason,
      status: input.status,
      toAgentDid: input.toAgentDid,
    });
    for (const socket of this.getActiveSockets(input.nowMs)) {
      try {
        socket.send(payload);
      } catch {
        // Best-effort notification; socket health is enforced by heartbeat sweeps.
      }
    }
  }

  private async drainReceiptFramesOnReconnect(nowMs: number): Promise<void> {
    const sockets = this.getActiveSockets(nowMs);
    if (sockets.length === 0) {
      return;
    }

    const queueState = await this.queueManager.loadQueueState(nowMs);
    for (const receipt of Object.values(queueState.receipts)) {
      if (
        receipt.expiresAtMs <= nowMs ||
        (receipt.state !== "processed_by_openclaw" &&
          receipt.state !== "dead_lettered")
      ) {
        continue;
      }

      this.pushReceiptFrameToActiveSockets({
        nowMs,
        originalFrameId: receipt.requestId,
        reason: receipt.reason,
        status: receipt.state,
        toAgentDid: receipt.recipientAgentDid,
      });
    }
  }
}

function readRelaySessionEnv(env: unknown): {
  AGENT_RELAY_SESSION?: AgentRelaySessionNamespace;
  PROXY_TRUST_STATE?: Parameters<
    typeof resolveWorkerTrustStore
  >[0]["trustStateNamespace"];
  [key: string]: unknown;
} {
  if (typeof env !== "object" || env === null) {
    return {};
  }

  return env as {
    AGENT_RELAY_SESSION?: AgentRelaySessionNamespace;
    PROXY_TRUST_STATE?: Parameters<
      typeof resolveWorkerTrustStore
    >[0]["trustStateNamespace"];
    [key: string]: unknown;
  };
}

function resolveRelayTrustStore(input: {
  environment: Parameters<typeof resolveWorkerTrustStore>[0]["environment"];
  trustStateNamespace?: Parameters<
    typeof resolveWorkerTrustStore
  >[0]["trustStateNamespace"];
}): ProxyTrustStore | undefined {
  if (input.environment === "local") {
    try {
      return resolveWorkerTrustStore(input).trustStore;
    } catch {
      return undefined;
    }
  }

  return resolveWorkerTrustStore(input).trustStore;
}
