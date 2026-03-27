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
import { sanitizeErrorReason } from "./runtime/errors.js";
import { deliverReceiptToOpenclawHook } from "./runtime/openclaw.js";
import { createOpenclawHookTokenController } from "./runtime/openclaw-hook-token.js";
import { createOpenclawGatewayProbeController } from "./runtime/openclaw-probe.js";
import { createOutboundQueuePersistence } from "./runtime/outbound-queue.js";
import { parseRequiredString } from "./runtime/parse.js";
import {
  loadInboundReplayPolicy,
  loadOpenclawProbePolicy,
} from "./runtime/policy.js";
import { createDeliveryReceiptOutbox } from "./runtime/receipt-outbox.js";
import { createRelayService } from "./runtime/relay-service.js";
import { loadSenderProfilesByDid } from "./runtime/relay-transform-peers.js";
import { createInboundReplayController } from "./runtime/replay.js";
import { createRuntimeRequestHandler } from "./runtime/server.js";
import type {
  ConnectorRuntimeHandle,
  OpenclawGatewayProbeStatus,
  StartConnectorRuntimeInput,
} from "./runtime/types.js";
import {
  normalizeOutboundBaseUrl,
  normalizeOutboundPath,
  normalizeWebSocketUrl,
  resolveOpenclawBaseUrl,
  resolveOpenclawHookPath,
  resolveOpenclawHookToken,
  resolveRegistryUrlFromIssuer,
  toHttpOriginFromWebSocketUrl,
  toOpenclawHookUrl,
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
  const openclawBaseUrl = resolveOpenclawBaseUrl(input.openclawBaseUrl);
  const openclawProbeUrl = openclawBaseUrl;
  const openclawHookPath = resolveOpenclawHookPath(input.openclawHookPath);
  const explicitOpenclawHookToken = resolveOpenclawHookToken(
    input.openclawHookToken,
  );
  const openclawHookUrl = toOpenclawHookUrl(openclawBaseUrl, openclawHookPath);

  const inboundReplayPolicy = loadInboundReplayPolicy();
  const openclawProbePolicy = loadOpenclawProbePolicy();

  const inboundInbox = createConnectorInboundInbox({
    configDir: input.configDir,
    agentName: input.agentName,
    eventsMaxBytes: inboundReplayPolicy.eventsMaxBytes,
    eventsMaxFiles: inboundReplayPolicy.eventsMaxFiles,
    maxPendingMessages: inboundReplayPolicy.inboxMaxMessages,
    maxPendingBytes: inboundReplayPolicy.inboxMaxBytes,
  });

  const openclawGatewayProbeStatus: OpenclawGatewayProbeStatus = {
    reachable: true,
  };

  let runtimeStopping = false;
  let replayIntervalHandle: ReturnType<typeof setInterval> | undefined;
  let openclawProbeIntervalHandle: ReturnType<typeof setInterval> | undefined;
  let receiptOutboxIntervalHandle: ReturnType<typeof setInterval> | undefined;
  const runtimeShutdownController = new AbortController();

  const openclawHookTokenController = createOpenclawHookTokenController({
    configDir: input.configDir,
    explicitOpenclawHookToken,
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
    status: "processed_by_openclaw" | "dead_lettered";
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
    getCurrentOpenclawHookToken:
      openclawHookTokenController.getCurrentOpenclawHookToken,
    inboundInbox,
    inboundReplayPolicy,
    isRuntimeStopping: () => runtimeStopping,
    loadSenderProfilesByDid: async () =>
      await loadSenderProfilesByDid({
        configDir: input.configDir,
        logger,
      }),
    logger,
    openclawGatewayProbeStatus,
    openclawHookUrl,
    openclawProbeUrl,
    postDeliveryReceipt: queueReceiptAndTryFlush,
    runtimeShutdownSignal: runtimeShutdownController.signal,
    syncOpenclawHookToken: openclawHookTokenController.syncOpenclawHookToken,
  });

  const openclawProbeController = createOpenclawGatewayProbeController({
    fetchImpl,
    isRuntimeStopping: () => runtimeStopping,
    logger,
    openclawGatewayProbeStatus,
    openclawProbePolicy,
    openclawProbeUrl,
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
    openclawBaseUrl,
    openclawHookPath,
    openclawHookToken:
      openclawHookTokenController.getCurrentOpenclawHookToken(),
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
          await deliverReceiptToOpenclawHook({
            fetchImpl,
            openclawHookUrl,
            openclawHookToken:
              openclawHookTokenController.getCurrentOpenclawHookToken(),
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
    if (openclawProbeIntervalHandle !== undefined) {
      clearInterval(openclawProbeIntervalHandle);
      openclawProbeIntervalHandle = undefined;
    }
    if (receiptOutboxIntervalHandle !== undefined) {
      clearInterval(receiptOutboxIntervalHandle);
      receiptOutboxIntervalHandle = undefined;
    }
    connectorClient.disconnect();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    stoppedResolve?.();
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

  await openclawHookTokenController.syncOpenclawHookToken("batch");
  await openclawProbeController.probeOpenclawGateway();
  connectorClient.connect();
  await inboundInbox.pruneDelivered();
  await receiptOutbox.flushDue();
  void replayController.replayPendingInboundMessages();

  replayIntervalHandle = setInterval(() => {
    void replayController.replayPendingInboundMessages();
  }, inboundReplayPolicy.replayIntervalMs);

  openclawProbeIntervalHandle = setInterval(() => {
    void openclawProbeController.probeOpenclawGateway();
  }, openclawProbePolicy.intervalMs);

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
