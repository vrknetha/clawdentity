import { createServer } from "node:http";
import {
  decodeBase64url,
  RELAY_DELIVERY_RECEIPTS_PATH,
} from "@clawdentity/protocol";
import { createLogger, decodeAIT } from "@clawdentity/sdk";
import { ConnectorClient } from "./client.js";
import { createConnectorInboundInbox } from "./inbound-inbox.js";
import { createRuntimeAuthController } from "./runtime/auth-lifecycle.js";
import { toInitialAuthBundle } from "./runtime/auth-storage.js";
import { RECEIPT_OUTBOX_RETRY_INTERVAL_MS } from "./runtime/constants.js";
import { deliverReceiptToDeliveryWebhookHook } from "./runtime/deliveryWebhook.js";
import { createDeliveryWebhookHookTokenController } from "./runtime/deliveryWebhook-hook-token.js";
import { createDeliveryWebhookGatewayProbeController } from "./runtime/deliveryWebhook-probe.js";
import { sanitizeErrorReason } from "./runtime/errors.js";
import { createOutboundQueuePersistence } from "./runtime/outbound-queue.js";
import { parseRequiredString } from "./runtime/parse.js";
import {
  loadDeliveryWebhookProbePolicy,
  loadInboundReplayPolicy,
} from "./runtime/policy.js";
import { createDeliveryReceiptOutbox } from "./runtime/receipt-outbox.js";
import { createRelayService } from "./runtime/relay-service.js";
import { loadSenderProfilesByDid } from "./runtime/relay-transform-peers.js";
import { createInboundReplayController } from "./runtime/replay.js";
import { createRuntimeRequestHandler } from "./runtime/server.js";
import type {
  ConnectorRuntimeHandle,
  DeliveryWebhookGatewayProbeStatus,
  StartConnectorRuntimeInput,
} from "./runtime/types.js";
import {
  normalizeOutboundBaseUrl,
  normalizeOutboundPath,
  normalizeWebSocketUrl,
  resolveDeliveryWebhookBaseUrl,
  resolveDeliveryWebhookHookPath,
  resolveDeliveryWebhookHookToken,
  resolveRegistryUrlFromIssuer,
  toDeliveryWebhookHookUrl,
  toHttpOriginFromWebSocketUrl,
} from "./runtime/url.js";
import { buildUpgradeHeaders, createWebSocketFactory } from "./runtime/ws.js";

export type {
  ConnectorRuntimeHandle,
  StartConnectorRuntimeInput,
} from "./runtime/types.js";

export async function startConnectorRuntime(
  input: StartConnectorRuntimeInput,
): Promise<ConnectorRuntimeHandle> {
  const logger =
    input.logger ?? createLogger({ service: "connector", module: "runtime" });
  const fetchImpl = input.fetchImpl ?? fetch;
  const decodedAit = decodeAIT(input.credentials.ait);
  const registryUrl = resolveRegistryUrlFromIssuer(decodedAit.claims.iss);

  const secretKey = decodeBase64url(
    parseRequiredString(input.credentials.secretKey, "secretKey"),
  );

  const authController = createRuntimeAuthController({
    agentName: input.agentName,
    ait: input.credentials.ait,
    configDir: input.configDir,
    fetchImpl,
    initialAuth: toInitialAuthBundle(input.credentials),
    logger,
    registryUrl,
    secretKey,
  });
  await authController.refreshCurrentAuthIfNeeded();

  const wsUrl = normalizeWebSocketUrl(input.proxyWebsocketUrl);
  const wsParsed = new URL(wsUrl);
  const defaultReceiptCallbackUrl = new URL(
    RELAY_DELIVERY_RECEIPTS_PATH.slice(1),
    `${toHttpOriginFromWebSocketUrl(wsParsed)}/`,
  ).toString();
  const deliveryWebhookBaseUrl = resolveDeliveryWebhookBaseUrl(
    input.deliveryWebhookBaseUrl,
  );
  const deliveryWebhookProbeUrl = deliveryWebhookBaseUrl;
  const deliveryWebhookPath = resolveDeliveryWebhookHookPath(
    input.deliveryWebhookPath,
  );
  const explicitDeliveryWebhookHookToken = resolveDeliveryWebhookHookToken(
    input.deliveryWebhookToken,
  );
  const deliveryWebhookHookUrl = toDeliveryWebhookHookUrl(
    deliveryWebhookBaseUrl,
    deliveryWebhookPath,
  );

  const inboundReplayPolicy = loadInboundReplayPolicy();
  const deliveryWebhookProbePolicy = loadDeliveryWebhookProbePolicy();

  const inboundInbox = createConnectorInboundInbox({
    configDir: input.configDir,
    agentName: input.agentName,
    eventsMaxRows: inboundReplayPolicy.eventsMaxRows,
    maxPendingMessages: inboundReplayPolicy.inboxMaxMessages,
    maxPendingBytes: inboundReplayPolicy.inboxMaxBytes,
  });

  const deliveryWebhookGatewayProbeStatus: DeliveryWebhookGatewayProbeStatus = {
    reachable: true,
  };

  let runtimeStopping = false;
  let replayIntervalHandle: ReturnType<typeof setInterval> | undefined;
  let deliveryWebhookProbeIntervalHandle:
    | ReturnType<typeof setInterval>
    | undefined;
  let receiptOutboxIntervalHandle: ReturnType<typeof setInterval> | undefined;
  const runtimeShutdownController = new AbortController();

  const deliveryWebhookTokenController =
    createDeliveryWebhookHookTokenController({
      configDir: input.configDir,
      explicitDeliveryWebhookHookToken,
      logger,
    });

  const resolveUpgradeHeaders = async (): Promise<Record<string, string>> => {
    await authController.refreshCurrentAuthIfNeeded();
    return buildUpgradeHeaders({
      wsUrl: wsParsed,
      ait: input.credentials.ait,
      accessToken: authController.getCurrentAuth().accessToken,
      secretKey,
    });
  };

  const outboundBaseUrl = normalizeOutboundBaseUrl(input.outboundBaseUrl);
  const outboundPath = normalizeOutboundPath(input.outboundPath);
  const outboundUrl = new URL(outboundPath, outboundBaseUrl).toString();

  const relayService = createRelayService({
    configDir: input.configDir,
    agentName: input.agentName,
    registryUrl,
    fetchImpl,
    secretKey,
    ait: input.credentials.ait,
    defaultReceiptCallbackUrl,
    getCurrentAuth: authController.getCurrentAuth,
    setCurrentAuth: authController.persistCurrentAuth,
    syncAuthFromDisk: authController.syncAuthFromDisk,
  });

  const receiptOutbox = createDeliveryReceiptOutbox({
    configDir: input.configDir,
    agentName: input.agentName,
    inboundReplayPolicy,
    logger,
    sendReceipt: relayService.postDeliveryReceipt,
  });

  const queueReceiptAndTryFlush = async (receipt: {
    reason?: string;
    recipientAgentDid: string;
    requestId: string;
    senderAgentDid: string;
    status: "delivered_to_webhook" | "dead_lettered";
  }): Promise<void> => {
    await receiptOutbox.enqueue(receipt);
    try {
      await receiptOutbox.flushDue();
    } catch (error) {
      logger.warn("connector.receipt_outbox.flush_failed", {
        requestId: receipt.requestId,
        status: receipt.status,
        reason: sanitizeErrorReason(error),
      });
    }
  };

  const replayController = createInboundReplayController({
    fetchImpl,
    getCurrentDeliveryWebhookHookToken:
      deliveryWebhookTokenController.getCurrentDeliveryWebhookHookToken,
    inboundInbox,
    inboundReplayPolicy,
    isRuntimeStopping: () => runtimeStopping,
    loadSenderProfilesByDid: async () =>
      await loadSenderProfilesByDid({
        configDir: input.configDir,
        logger,
      }),
    logger,
    deliveryWebhookGatewayProbeStatus,
    deliveryWebhookHookUrl,
    deliveryWebhookProbeUrl,
    postDeliveryReceipt: queueReceiptAndTryFlush,
    runtimeShutdownSignal: runtimeShutdownController.signal,
    syncDeliveryWebhookHookToken:
      deliveryWebhookTokenController.syncDeliveryWebhookHookToken,
  });

  const deliveryWebhookProbeController =
    createDeliveryWebhookGatewayProbeController({
      fetchImpl,
      isRuntimeStopping: () => runtimeStopping,
      logger,
      deliveryWebhookGatewayProbeStatus,
      deliveryWebhookProbePolicy,
      deliveryWebhookProbeUrl,
      runtimeShutdownSignal: runtimeShutdownController.signal,
    });

  const outboundQueuePersistence = createOutboundQueuePersistence({
    configDir: input.configDir,
    agentName: input.agentName,
    logger,
  });

  const connectorClient = new ConnectorClient({
    connectorUrl: wsParsed.toString(),
    connectionHeadersProvider: resolveUpgradeHeaders,
    deliveryWebhookBaseUrl,
    deliveryWebhookPath,
    deliveryWebhookToken:
      deliveryWebhookTokenController.getCurrentDeliveryWebhookHookToken(),
    fetchImpl,
    logger,
    hooks: {
      onAuthUpgradeRejected: async ({ status, immediateRetry }) => {
        logger.warn("connector.websocket.auth_upgrade_rejected", {
          status,
          immediateRetry,
        });
        await authController.syncAuthFromDisk();
        try {
          await authController.refreshCurrentAuth();
        } catch (error) {
          logger.warn(
            "connector.runtime.registry_auth_refresh_on_ws_upgrade_reject_failed",
            {
              reason: sanitizeErrorReason(error),
            },
          );
        }
      },
      onReceipt: async (frame) => {
        try {
          await deliverReceiptToDeliveryWebhookHook({
            fetchImpl,
            deliveryWebhookHookUrl,
            deliveryWebhookToken:
              deliveryWebhookTokenController.getCurrentDeliveryWebhookHookToken(),
            receipt: frame,
            shutdownSignal: runtimeShutdownController.signal,
          });
        } catch (error) {
          if (runtimeShutdownController.signal.aborted) {
            return;
          }
          logger.warn("connector.receipt.delivery_failed", {
            requestId: frame.originalFrameId,
            status: frame.status,
            reason: sanitizeErrorReason(error),
          });
        }
      },
    },
    outboundQueuePersistence,
    inboundDeliverHandler: async (frame) => {
      const persisted = await inboundInbox.enqueue(frame);
      if (!persisted.accepted) {
        logger.warn("connector.inbound.persist_rejected", {
          requestId: frame.id,
          reason: persisted.reason ?? "inbox limit reached",
          pendingCount: persisted.pendingCount,
        });
        return {
          accepted: false,
          reason: persisted.reason,
        };
      }

      logger.info("connector.inbound.persisted", {
        requestId: frame.id,
        duplicate: persisted.duplicate,
        pendingCount: persisted.pendingCount,
      });
      void replayController.replayPendingInboundMessages();
      return { accepted: true };
    },
    webSocketFactory: createWebSocketFactory(),
  });

  const server = createServer(
    createRuntimeRequestHandler({
      connectorClient,
      inboundInbox,
      logger,
      outboundBaseUrl,
      outboundPath,
      outboundUrl,
      readInboundReplayView: replayController.readInboundReplayView,
      relayToPeer: relayService.relayToPeer,
      replayPendingInboundMessages: () => {
        void replayController.replayPendingInboundMessages();
      },
      wsUrl,
    }),
  );

  let stoppedResolve: (() => void) | undefined;
  const stoppedPromise = new Promise<void>((resolve) => {
    stoppedResolve = resolve;
  });

  const stop = async (): Promise<void> => {
    runtimeStopping = true;
    runtimeShutdownController.abort();
    if (replayIntervalHandle !== undefined) {
      clearInterval(replayIntervalHandle);
      replayIntervalHandle = undefined;
    }
    if (deliveryWebhookProbeIntervalHandle !== undefined) {
      clearInterval(deliveryWebhookProbeIntervalHandle);
      deliveryWebhookProbeIntervalHandle = undefined;
    }
    if (receiptOutboxIntervalHandle !== undefined) {
      clearInterval(receiptOutboxIntervalHandle);
      receiptOutboxIntervalHandle = undefined;
    }
    connectorClient.disconnect();
    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    } finally {
      await inboundInbox.close();
      stoppedResolve?.();
    }
  };

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(
      Number(outboundBaseUrl.port || "80"),
      outboundBaseUrl.hostname,
      () => {
        server.off("error", reject);
        resolve();
      },
    );
  });

  await deliveryWebhookTokenController.syncDeliveryWebhookHookToken("batch");
  await deliveryWebhookProbeController.probeDeliveryWebhookGateway();
  connectorClient.connect();
  await inboundInbox.pruneDelivered();
  await receiptOutbox.flushDue();
  void replayController.replayPendingInboundMessages();

  replayIntervalHandle = setInterval(() => {
    void replayController.replayPendingInboundMessages();
  }, inboundReplayPolicy.replayIntervalMs);

  deliveryWebhookProbeIntervalHandle = setInterval(() => {
    void deliveryWebhookProbeController.probeDeliveryWebhookGateway();
  }, deliveryWebhookProbePolicy.intervalMs);

  receiptOutboxIntervalHandle = setInterval(() => {
    void receiptOutbox.flushDue();
  }, RECEIPT_OUTBOX_RETRY_INTERVAL_MS);

  logger.info("connector.runtime.started", {
    outboundUrl,
    websocketUrl: wsUrl,
    agentDid: input.credentials.agentDid,
  });

  return {
    outboundUrl,
    websocketUrl: wsUrl,
    stop,
    waitUntilStopped: async () => stoppedPromise,
  };
}
