import type { Logger } from "@clawdentity/sdk";
import { nowIso, nowUtcMs, toIso } from "@clawdentity/sdk";
import type {
  ConnectorInboundInbox,
  ConnectorInboundInboxItem,
  ConnectorInboundInboxSnapshot,
} from "../inbound-inbox.js";
import { LocalOpenclawDeliveryError, sanitizeErrorReason } from "./errors.js";
import { deliverToOpenclawHook, waitWithAbort } from "./openclaw.js";
import {
  computeReplayDelayMs,
  computeRuntimeReplayRetryDelayMs,
} from "./policy.js";
import type {
  InboundReplayPolicy,
  InboundReplayStatus,
  InboundReplayView,
  OpenclawGatewayProbeStatus,
} from "./types.js";

type DeliveryReceiptInput = {
  reason?: string;
  recipientAgentDid: string;
  replyTo: string;
  requestId: string;
  senderAgentDid: string;
  status: "processed_by_openclaw" | "dead_lettered";
};

function groupDueItemsByLane(
  dueItems: ConnectorInboundInboxItem[],
): ConnectorInboundInboxItem[][] {
  const laneByKey = new Map<string, ConnectorInboundInboxItem[]>();

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

  return Array.from(laneByKey.values());
}

export function createInboundReplayController(input: {
  fetchImpl: typeof fetch;
  getCurrentOpenclawHookToken: () => string | undefined;
  inboundInbox: ConnectorInboundInbox;
  inboundReplayPolicy: InboundReplayPolicy;
  isRuntimeStopping: () => boolean;
  logger: Logger;
  openclawGatewayProbeStatus: OpenclawGatewayProbeStatus;
  openclawHookUrl: string;
  openclawProbeUrl: string;
  postDeliveryReceipt: (inputReceipt: DeliveryReceiptInput) => Promise<void>;
  runtimeShutdownSignal: AbortSignal;
  syncOpenclawHookToken: (reason: "auth_rejected" | "batch") => Promise<void>;
}): {
  readInboundReplayView: () => Promise<InboundReplayView>;
  replayPendingInboundMessages: () => Promise<void>;
} {
  const inboundReplayStatus: InboundReplayStatus = {
    replayerActive: false,
  };

  let replayInFlight = false;

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
          fetchImpl: input.fetchImpl,
          fromAgentDid: inputReplay.fromAgentDid,
          openclawHookUrl: input.openclawHookUrl,
          openclawHookToken: input.getCurrentOpenclawHookToken(),
          payload: inputReplay.payload,
          requestId: inputReplay.requestId,
          shutdownSignal: input.runtimeShutdownSignal,
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
          const previousToken = input.getCurrentOpenclawHookToken();
          await input.syncOpenclawHookToken("auth_rejected");
          const tokenChanged =
            input.getCurrentOpenclawHookToken() !== previousToken;
          const attemptsRemaining =
            attempt < input.inboundReplayPolicy.runtimeReplayMaxAttempts;
          if (tokenChanged && !input.isRuntimeStopping() && attemptsRemaining) {
            input.logger.warn(
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
          attempt < input.inboundReplayPolicy.runtimeReplayMaxAttempts;
        if (!retryable || !attemptsRemaining || input.isRuntimeStopping()) {
          throw error;
        }

        const retryDelayMs = computeRuntimeReplayRetryDelayMs({
          attemptCount: attempt,
          policy: input.inboundReplayPolicy,
        });
        input.logger.warn("connector.inbound.replay_retry_scheduled", {
          requestId: inputReplay.requestId,
          attempt,
          retryDelayMs,
          reason: sanitizeErrorReason(error),
        });
        await waitWithAbort({
          delayMs: retryDelayMs,
          signal: input.runtimeShutdownSignal,
        });
        attempt += 1;
      }
    }
  };

  const readInboundReplayView = async (): Promise<InboundReplayView> => {
    const snapshot: ConnectorInboundInboxSnapshot =
      await input.inboundInbox.getSnapshot();
    return {
      snapshot,
      replayerActive: inboundReplayStatus.replayerActive || replayInFlight,
      lastReplayAt: inboundReplayStatus.lastReplayAt,
      lastReplayError: inboundReplayStatus.lastReplayError,
      openclawGateway: {
        url: input.openclawProbeUrl,
        reachable: input.openclawGatewayProbeStatus.reachable,
        lastCheckedAt: input.openclawGatewayProbeStatus.lastCheckedAt,
        lastSuccessAt: input.openclawGatewayProbeStatus.lastSuccessAt,
        lastFailureReason: input.openclawGatewayProbeStatus.lastFailureReason,
      },
      openclawHook: {
        url: input.openclawHookUrl,
        lastAttemptAt: inboundReplayStatus.lastAttemptAt,
        lastAttemptStatus: inboundReplayStatus.lastAttemptStatus,
      },
    };
  };

  const replayPendingInboundMessages = async (): Promise<void> => {
    if (input.isRuntimeStopping() || replayInFlight) {
      return;
    }

    replayInFlight = true;
    inboundReplayStatus.replayerActive = true;

    try {
      const dueItems = await input.inboundInbox.listDuePending({
        nowMs: nowUtcMs(),
        limit: input.inboundReplayPolicy.batchSize,
      });
      if (dueItems.length === 0) {
        return;
      }

      await input.syncOpenclawHookToken("batch");
      if (!input.openclawGatewayProbeStatus.reachable) {
        input.logger.info(
          "connector.inbound.replay_skipped_gateway_unreachable",
          {
            pendingCount: dueItems.length,
            openclawBaseUrl: input.openclawProbeUrl,
            lastFailureReason:
              input.openclawGatewayProbeStatus.lastFailureReason,
          },
        );
        return;
      }

      const laneItems = groupDueItemsByLane(dueItems);
      await Promise.all(
        laneItems.map(async (lane) => {
          for (const pending of lane) {
            inboundReplayStatus.lastAttemptAt = nowIso();
            try {
              await deliverToOpenclawHookWithRetry({
                fromAgentDid: pending.fromAgentDid,
                requestId: pending.requestId,
                payload: pending.payload,
                toAgentDid: pending.toAgentDid,
              });
              await input.inboundInbox.markDelivered(pending.requestId);
              inboundReplayStatus.lastReplayAt = nowIso();
              inboundReplayStatus.lastReplayError = undefined;
              inboundReplayStatus.lastAttemptStatus = "ok";
              input.logger.info("connector.inbound.replay_succeeded", {
                requestId: pending.requestId,
                attemptCount: pending.attemptCount + 1,
                conversationId: pending.conversationId,
              });

              if (pending.replyTo) {
                try {
                  await input.postDeliveryReceipt({
                    requestId: pending.requestId,
                    senderAgentDid: pending.fromAgentDid,
                    recipientAgentDid: pending.toAgentDid,
                    replyTo: pending.replyTo,
                    status: "processed_by_openclaw",
                  });
                } catch (error) {
                  input.logger.warn(
                    "connector.inbound.delivery_receipt_failed",
                    {
                      requestId: pending.requestId,
                      reason: sanitizeErrorReason(error),
                      status: "processed_by_openclaw",
                    },
                  );
                }
              }
            } catch (error) {
              if (
                error instanceof LocalOpenclawDeliveryError &&
                error.code === "RUNTIME_STOPPING"
              ) {
                input.logger.info("connector.inbound.replay_stopped", {
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
                    policy: input.inboundReplayPolicy,
                  }) *
                    (retryable ? 1 : 10),
              );

              const markResult = await input.inboundInbox.markReplayFailure({
                requestId: pending.requestId,
                errorMessage: reason,
                nextAttemptAt,
                retryable,
                maxNonRetryableAttempts:
                  input.inboundReplayPolicy.deadLetterNonRetryableMaxAttempts,
              });
              inboundReplayStatus.lastReplayError = reason;
              inboundReplayStatus.lastAttemptStatus = "failed";
              input.logger.warn("connector.inbound.replay_failed", {
                requestId: pending.requestId,
                attemptCount: pending.attemptCount + 1,
                retryable,
                nextAttemptAt,
                movedToDeadLetter: markResult.movedToDeadLetter,
                reason,
              });

              if (markResult.movedToDeadLetter && pending.replyTo) {
                try {
                  await input.postDeliveryReceipt({
                    requestId: pending.requestId,
                    senderAgentDid: pending.fromAgentDid,
                    recipientAgentDid: pending.toAgentDid,
                    replyTo: pending.replyTo,
                    status: "dead_lettered",
                    reason,
                  });
                } catch (receiptError) {
                  input.logger.warn(
                    "connector.inbound.delivery_receipt_failed",
                    {
                      requestId: pending.requestId,
                      reason: sanitizeErrorReason(receiptError),
                      status: "dead_lettered",
                    },
                  );
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

  return {
    readInboundReplayView,
    replayPendingInboundMessages,
  };
}
