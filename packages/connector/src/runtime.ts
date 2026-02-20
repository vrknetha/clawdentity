import { createServer } from "node:http";
import {
  decodeBase64url,
  RELAY_DELIVERY_RECEIPTS_PATH,
} from "@clawdentity/protocol";
import {
  createLogger,
  nowIso,
  nowUtcMs,
  refreshAgentAuthWithClawProof,
  toIso,
} from "@clawdentity/sdk";
import { ConnectorClient } from "./client.js";
import {
  type ConnectorInboundInboxSnapshot,
  createConnectorInboundInbox,
} from "./inbound-inbox.js";
import {
  readRegistryAuthFromDisk,
  toInitialAuthBundle,
  writeRegistryAuthAtomic,
} from "./runtime/auth-storage.js";
import {
  LocalOpenclawDeliveryError,
  sanitizeErrorReason,
} from "./runtime/errors.js";
import {
  deliverToOpenclawHook,
  readOpenclawHookTokenFromRelayRuntimeConfig,
  waitWithAbort,
} from "./runtime/openclaw.js";
import { createOutboundQueuePersistence } from "./runtime/outbound-queue.js";
import {
  parseRequiredString,
  shouldRefreshAccessToken,
} from "./runtime/parse.js";
import {
  computeReplayDelayMs,
  computeRuntimeReplayRetryDelayMs,
  loadInboundReplayPolicy,
  loadOpenclawProbePolicy,
} from "./runtime/policy.js";
import { createRelayService } from "./runtime/relay-service.js";
import { createRuntimeRequestHandler } from "./runtime/server.js";
import { loadTrustedReceiptTargets } from "./runtime/trusted-receipts.js";
import type {
  ConnectorRuntimeHandle,
  InboundReplayStatus,
  InboundReplayView,
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

  const secretKey = decodeBase64url(
    parseRequiredString(input.credentials.secretKey, "secretKey"),
  );
  let currentAuth = toInitialAuthBundle(input.credentials);

  const syncAuthFromDisk = async (): Promise<void> => {
    const diskAuth = await readRegistryAuthFromDisk({
      configDir: input.configDir,
      agentName: input.agentName,
      logger,
    });
    if (!diskAuth) {
      return;
    }

    if (
      diskAuth.accessToken === currentAuth.accessToken &&
      diskAuth.accessExpiresAt === currentAuth.accessExpiresAt &&
      diskAuth.refreshToken === currentAuth.refreshToken &&
      diskAuth.refreshExpiresAt === currentAuth.refreshExpiresAt
    ) {
      return;
    }

    currentAuth = diskAuth;
    logger.info("connector.runtime.registry_auth_synced", {
      agentName: input.agentName,
    });
  };

  const persistCurrentAuth = async (
    nextAuth: typeof currentAuth,
  ): Promise<void> => {
    currentAuth = nextAuth;
    await writeRegistryAuthAtomic({
      configDir: input.configDir,
      agentName: input.agentName,
      auth: nextAuth,
    });
  };

  const refreshCurrentAuth = async (): Promise<void> => {
    const refreshed = await refreshAgentAuthWithClawProof({
      registryUrl: input.registryUrl,
      ait: input.credentials.ait,
      secretKey,
      refreshToken: currentAuth.refreshToken,
      fetchImpl,
    });
    await persistCurrentAuth(refreshed);
  };

  const refreshCurrentAuthIfNeeded = async (): Promise<void> => {
    await syncAuthFromDisk();
    if (!shouldRefreshAccessToken(currentAuth, nowUtcMs())) {
      return;
    }

    await refreshCurrentAuth();
  };

  await refreshCurrentAuthIfNeeded();

  const wsUrl = normalizeWebSocketUrl(input.proxyWebsocketUrl);
  const wsParsed = new URL(wsUrl);
  const defaultReceiptCallbackUrl = new URL(
    RELAY_DELIVERY_RECEIPTS_PATH.slice(1),
    `${toHttpOriginFromWebSocketUrl(wsParsed)}/`,
  ).toString();
  const defaultReceiptCallbackOrigin = new URL(defaultReceiptCallbackUrl)
    .origin;
  const openclawBaseUrl = resolveOpenclawBaseUrl(input.openclawBaseUrl);
  const openclawProbeUrl = openclawBaseUrl;
  const openclawHookPath = resolveOpenclawHookPath(input.openclawHookPath);
  const explicitOpenclawHookToken = resolveOpenclawHookToken(
    input.openclawHookToken,
  );
  const hasExplicitOpenclawHookToken = explicitOpenclawHookToken !== undefined;
  let currentOpenclawHookToken = explicitOpenclawHookToken;
  const openclawHookUrl = toOpenclawHookUrl(openclawBaseUrl, openclawHookPath);
  const inboundReplayPolicy = loadInboundReplayPolicy();
  const openclawProbePolicy = loadOpenclawProbePolicy();
  const trustedReceiptTargets = await loadTrustedReceiptTargets({
    configDir: input.configDir,
    logger,
  });
  trustedReceiptTargets.origins.add(defaultReceiptCallbackOrigin);

  const inboundInbox = createConnectorInboundInbox({
    configDir: input.configDir,
    agentName: input.agentName,
    eventsMaxBytes: inboundReplayPolicy.eventsMaxBytes,
    eventsMaxFiles: inboundReplayPolicy.eventsMaxFiles,
    maxPendingMessages: inboundReplayPolicy.inboxMaxMessages,
    maxPendingBytes: inboundReplayPolicy.inboxMaxBytes,
  });

  const inboundReplayStatus: InboundReplayStatus = {
    replayerActive: false,
  };
  const openclawGatewayProbeStatus: OpenclawGatewayProbeStatus = {
    reachable: true,
  };

  let openclawProbeInFlight = false;
  let runtimeStopping = false;
  let replayInFlight = false;
  let replayIntervalHandle: ReturnType<typeof setInterval> | undefined;
  let openclawProbeIntervalHandle: ReturnType<typeof setInterval> | undefined;
  const runtimeShutdownController = new AbortController();

  const resolveUpgradeHeaders = async (): Promise<Record<string, string>> => {
    await refreshCurrentAuthIfNeeded();
    return buildUpgradeHeaders({
      wsUrl: wsParsed,
      ait: input.credentials.ait,
      accessToken: currentAuth.accessToken,
      secretKey,
    });
  };

  const syncOpenclawHookToken = async (reason: "auth_rejected" | "batch") => {
    if (hasExplicitOpenclawHookToken) {
      return;
    }

    const diskToken = await readOpenclawHookTokenFromRelayRuntimeConfig({
      configDir: input.configDir,
      logger,
    });
    if (diskToken === currentOpenclawHookToken) {
      return;
    }

    currentOpenclawHookToken = diskToken;
    logger.info("connector.runtime.openclaw_hook_token_synced", {
      reason,
      source: diskToken !== undefined ? "openclaw-relay.json" : "unset",
      hasToken: currentOpenclawHookToken !== undefined,
    });
  };

  const probeOpenclawGateway = async (): Promise<void> => {
    if (runtimeStopping || openclawProbeInFlight) {
      return;
    }
    openclawProbeInFlight = true;

    const checkedAt = nowIso();
    try {
      const timeoutSignal = AbortSignal.timeout(openclawProbePolicy.timeoutMs);
      const signal = AbortSignal.any([
        runtimeShutdownController.signal,
        timeoutSignal,
      ]);
      await fetchImpl(openclawProbeUrl, {
        method: "GET",
        signal,
      });
      openclawGatewayProbeStatus.reachable = true;
      openclawGatewayProbeStatus.lastCheckedAt = checkedAt;
      openclawGatewayProbeStatus.lastSuccessAt = checkedAt;
      openclawGatewayProbeStatus.lastFailureReason = undefined;
    } catch (error) {
      if (runtimeShutdownController.signal.aborted) {
        return;
      }
      openclawGatewayProbeStatus.reachable = false;
      openclawGatewayProbeStatus.lastCheckedAt = checkedAt;
      openclawGatewayProbeStatus.lastFailureReason = sanitizeErrorReason(error);
    } finally {
      openclawProbeInFlight = false;
    }
  };

  const deliverToOpenclawHookWithRetry = async (inputReplay: {
    fromAgentDid: string;
    payload: unknown;
    requestId: string;
    toAgentDid: string;
  }): Promise<void> => {
    let attempt = 1;

    while (true) {
      try {
        await deliverToOpenclawHook({
          fetchImpl,
          fromAgentDid: inputReplay.fromAgentDid,
          openclawHookUrl,
          openclawHookToken: currentOpenclawHookToken,
          payload: inputReplay.payload,
          requestId: inputReplay.requestId,
          shutdownSignal: runtimeShutdownController.signal,
          toAgentDid: inputReplay.toAgentDid,
        });
        return;
      } catch (error) {
        if (
          error instanceof LocalOpenclawDeliveryError &&
          error.code === "RUNTIME_STOPPING"
        ) {
          throw error;
        }

        const retryable =
          error instanceof LocalOpenclawDeliveryError ? error.retryable : true;
        const authRejected =
          error instanceof LocalOpenclawDeliveryError &&
          error.code === "HOOK_AUTH_REJECTED";

        if (authRejected) {
          const previousToken = currentOpenclawHookToken;
          await syncOpenclawHookToken("auth_rejected");
          const tokenChanged = currentOpenclawHookToken !== previousToken;
          const attemptsRemaining =
            attempt < inboundReplayPolicy.runtimeReplayMaxAttempts;
          if (tokenChanged && !runtimeStopping && attemptsRemaining) {
            logger.warn(
              "connector.inbound.replay_hook_auth_rejected_retrying",
              {
                requestId: inputReplay.requestId,
                attempt,
              },
            );
            attempt += 1;
            continue;
          }
        }

        const attemptsRemaining =
          attempt < inboundReplayPolicy.runtimeReplayMaxAttempts;
        if (!retryable || !attemptsRemaining || runtimeStopping) {
          throw error;
        }

        const retryDelayMs = computeRuntimeReplayRetryDelayMs({
          attemptCount: attempt,
          policy: inboundReplayPolicy,
        });
        logger.warn("connector.inbound.replay_retry_scheduled", {
          requestId: inputReplay.requestId,
          attempt,
          retryDelayMs,
          reason: sanitizeErrorReason(error),
        });
        await waitWithAbort({
          delayMs: retryDelayMs,
          signal: runtimeShutdownController.signal,
        });
        attempt += 1;
      }
    }
  };

  const readInboundReplayView = async (): Promise<InboundReplayView> => {
    const snapshot: ConnectorInboundInboxSnapshot =
      await inboundInbox.getSnapshot();
    return {
      snapshot,
      replayerActive: inboundReplayStatus.replayerActive || replayInFlight,
      lastReplayAt: inboundReplayStatus.lastReplayAt,
      lastReplayError: inboundReplayStatus.lastReplayError,
      openclawGateway: {
        url: openclawProbeUrl,
        reachable: openclawGatewayProbeStatus.reachable,
        lastCheckedAt: openclawGatewayProbeStatus.lastCheckedAt,
        lastSuccessAt: openclawGatewayProbeStatus.lastSuccessAt,
        lastFailureReason: openclawGatewayProbeStatus.lastFailureReason,
      },
      openclawHook: {
        url: openclawHookUrl,
        lastAttemptAt: inboundReplayStatus.lastAttemptAt,
        lastAttemptStatus: inboundReplayStatus.lastAttemptStatus,
      },
    };
  };

  const replayPendingInboundMessages = async (): Promise<void> => {
    if (runtimeStopping || replayInFlight) {
      return;
    }

    replayInFlight = true;
    inboundReplayStatus.replayerActive = true;

    try {
      const dueItems = await inboundInbox.listDuePending({
        nowMs: nowUtcMs(),
        limit: inboundReplayPolicy.batchSize,
      });
      if (dueItems.length === 0) {
        return;
      }
      await syncOpenclawHookToken("batch");
      if (!openclawGatewayProbeStatus.reachable) {
        logger.info("connector.inbound.replay_skipped_gateway_unreachable", {
          pendingCount: dueItems.length,
          openclawBaseUrl: openclawProbeUrl,
          lastFailureReason: openclawGatewayProbeStatus.lastFailureReason,
        });
        return;
      }

      const laneByKey = new Map<string, typeof dueItems>();
      for (const pending of dueItems) {
        const laneKey =
          pending.conversationId !== undefined
            ? `conversation:${pending.conversationId}`
            : "legacy-best-effort";
        const lane = laneByKey.get(laneKey);
        if (lane) {
          lane.push(pending);
        } else {
          laneByKey.set(laneKey, [pending]);
        }
      }

      await Promise.all(
        Array.from(laneByKey.values()).map(async (laneItems) => {
          for (const pending of laneItems) {
            inboundReplayStatus.lastAttemptAt = nowIso();
            try {
              await deliverToOpenclawHookWithRetry({
                fromAgentDid: pending.fromAgentDid,
                requestId: pending.requestId,
                payload: pending.payload,
                toAgentDid: pending.toAgentDid,
              });
              await inboundInbox.markDelivered(pending.requestId);
              inboundReplayStatus.lastReplayAt = nowIso();
              inboundReplayStatus.lastReplayError = undefined;
              inboundReplayStatus.lastAttemptStatus = "ok";
              logger.info("connector.inbound.replay_succeeded", {
                requestId: pending.requestId,
                attemptCount: pending.attemptCount + 1,
                conversationId: pending.conversationId,
              });

              if (pending.replyTo) {
                try {
                  await relayService.postDeliveryReceipt({
                    requestId: pending.requestId,
                    senderAgentDid: pending.fromAgentDid,
                    recipientAgentDid: pending.toAgentDid,
                    replyTo: pending.replyTo,
                    status: "processed_by_openclaw",
                  });
                } catch (error) {
                  logger.warn("connector.inbound.delivery_receipt_failed", {
                    requestId: pending.requestId,
                    reason: sanitizeErrorReason(error),
                    status: "processed_by_openclaw",
                  });
                }
              }
            } catch (error) {
              if (
                error instanceof LocalOpenclawDeliveryError &&
                error.code === "RUNTIME_STOPPING"
              ) {
                logger.info("connector.inbound.replay_stopped", {
                  requestId: pending.requestId,
                });
                return;
              }
              const reason = sanitizeErrorReason(error);
              const retryable =
                error instanceof LocalOpenclawDeliveryError
                  ? error.retryable
                  : true;
              const nextAttemptAt = toIso(
                nowUtcMs() +
                  computeReplayDelayMs({
                    attemptCount: pending.attemptCount + 1,
                    policy: inboundReplayPolicy,
                  }) *
                    (retryable ? 1 : 10),
              );
              const markResult = await inboundInbox.markReplayFailure({
                requestId: pending.requestId,
                errorMessage: reason,
                nextAttemptAt,
                retryable,
                maxNonRetryableAttempts:
                  inboundReplayPolicy.deadLetterNonRetryableMaxAttempts,
              });
              inboundReplayStatus.lastReplayError = reason;
              inboundReplayStatus.lastAttemptStatus = "failed";
              logger.warn("connector.inbound.replay_failed", {
                requestId: pending.requestId,
                attemptCount: pending.attemptCount + 1,
                retryable,
                nextAttemptAt,
                movedToDeadLetter: markResult.movedToDeadLetter,
                reason,
              });

              if (markResult.movedToDeadLetter && pending.replyTo) {
                try {
                  await relayService.postDeliveryReceipt({
                    requestId: pending.requestId,
                    senderAgentDid: pending.fromAgentDid,
                    recipientAgentDid: pending.toAgentDid,
                    replyTo: pending.replyTo,
                    status: "dead_lettered",
                    reason,
                  });
                } catch (receiptError) {
                  logger.warn("connector.inbound.delivery_receipt_failed", {
                    requestId: pending.requestId,
                    reason: sanitizeErrorReason(receiptError),
                    status: "dead_lettered",
                  });
                }
              }
            }
          }
        }),
      );
    } finally {
      replayInFlight = false;
      inboundReplayStatus.replayerActive = false;
    }
  };

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
    openclawHookToken: currentOpenclawHookToken,
    fetchImpl,
    logger,
    hooks: {
      onAuthUpgradeRejected: async ({ status, immediateRetry }) => {
        logger.warn("connector.websocket.auth_upgrade_rejected", {
          status,
          immediateRetry,
        });
        await syncAuthFromDisk();
        try {
          await refreshCurrentAuth();
        } catch (error) {
          logger.warn(
            "connector.runtime.registry_auth_refresh_on_ws_upgrade_reject_failed",
            {
              reason: sanitizeErrorReason(error),
            },
          );
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
      void replayPendingInboundMessages();
      return { accepted: true };
    },
    webSocketFactory: createWebSocketFactory(),
  });

  const outboundBaseUrl = normalizeOutboundBaseUrl(input.outboundBaseUrl);
  const outboundPath = normalizeOutboundPath(input.outboundPath);
  const outboundUrl = new URL(outboundPath, outboundBaseUrl).toString();

  const relayService = createRelayService({
    configDir: input.configDir,
    agentName: input.agentName,
    registryUrl: input.registryUrl,
    fetchImpl,
    secretKey,
    ait: input.credentials.ait,
    defaultReceiptCallbackUrl,
    trustedReceiptTargets,
    getCurrentAuth: () => currentAuth,
    setCurrentAuth: persistCurrentAuth,
    syncAuthFromDisk,
  });

  const server = createServer(
    createRuntimeRequestHandler({
      connectorClient,
      inboundInbox,
      logger,
      outboundBaseUrl,
      outboundPath,
      outboundUrl,
      readInboundReplayView,
      relayToPeer: relayService.relayToPeer,
      replayPendingInboundMessages: () => {
        void replayPendingInboundMessages();
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

  await syncOpenclawHookToken("batch");
  await probeOpenclawGateway();
  connectorClient.connect();
  await inboundInbox.pruneDelivered();
  void replayPendingInboundMessages();
  replayIntervalHandle = setInterval(() => {
    void replayPendingInboundMessages();
  }, inboundReplayPolicy.replayIntervalMs);
  openclawProbeIntervalHandle = setInterval(() => {
    void probeOpenclawGateway();
  }, openclawProbePolicy.intervalMs);

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
