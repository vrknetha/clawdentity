import type { Logger } from "@clawdentity/sdk";
import { nowIso, nowUtcMs, toIso } from "@clawdentity/sdk";
import type { DeliveryWebhookSenderProfile } from "../deliveryWebhook-headers.js";
import type {
  ConnectorInboundInbox,
  ConnectorInboundInboxItem,
  ConnectorInboundInboxSnapshot,
} from "../inbound-inbox.js";
import {
  deliverToDeliveryWebhookHook,
  waitWithAbort,
} from "./deliveryWebhook.js";
import {
  LocalDeliveryWebhookDeliveryError,
  sanitizeErrorReason,
} from "./errors.js";
import {
  computeReplayDelayMs,
  computeRuntimeReplayRetryDelayMs,
} from "./policy.js";
import type {
  DeliveryWebhookGatewayProbeStatus,
  InboundReplayPolicy,
  InboundReplayStatus,
  InboundReplayView,
} from "./types.js";

type DeliveryReceiptInput = {
  reason?: string;
  recipientAgentDid: string;
  requestId: string;
  senderAgentDid: string;
  status: "delivered_to_webhook" | "dead_lettered";
};

function sanitizeStatusUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed.length === 0) {
    return "";
  }
  try {
    const parsed = new URL(trimmed);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

function groupDueItemsByLane(
  dueItems: ConnectorInboundInboxItem[],
): ConnectorInboundInboxItem[][] {
  const laneByKey = new Map<string, ConnectorInboundInboxItem[]>();

  for (const pending of dueItems) {
    const laneKey =
      pending.conversationId !== undefined
        ? `conversation:${pending.conversationId}`
        : "best-effort";
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
  getCurrentDeliveryWebhookHookToken: () => string | undefined;
  inboundInbox: ConnectorInboundInbox;
  inboundReplayPolicy: InboundReplayPolicy;
  isRuntimeStopping: () => boolean;
  loadSenderProfilesByDid: () => Promise<
    Map<string, DeliveryWebhookSenderProfile>
  >;
  logger: Logger;
  deliveryWebhookGatewayProbeStatus: DeliveryWebhookGatewayProbeStatus;
  deliveryWebhookHookUrl: string;
  deliveryWebhookProbeUrl: string;
  postDeliveryReceipt: (inputReceipt: DeliveryReceiptInput) => Promise<void>;
  runtimeShutdownSignal: AbortSignal;
  syncDeliveryWebhookHookToken: (
    reason: "auth_rejected" | "batch",
  ) => Promise<void>;
}): {
  readInboundReplayView: () => Promise<InboundReplayView>;
  replayPendingInboundMessages: () => Promise<void>;
} {
  const inboundReplayStatus: InboundReplayStatus = {
    replayerActive: false,
  };

  let replayInFlight = false;
  const sanitizedDeliveryWebhookProbeUrl = sanitizeStatusUrl(
    input.deliveryWebhookProbeUrl,
  );
  const sanitizedDeliveryWebhookHookUrl = sanitizeStatusUrl(
    input.deliveryWebhookHookUrl,
  );

  const deliverToDeliveryWebhookHookWithRetry = async (inputReplay: {
    conversationId?: string;
    fromAgentDid: string;
    groupId?: string;
    payload: unknown;
    replyTo?: string;
    requestId: string;
    senderProfile?: DeliveryWebhookSenderProfile;
    toAgentDid: string;
  }): Promise<void> => {
    let attempt = 1;

    while (true) {
      try {
        await deliverToDeliveryWebhookHook({
          fetchImpl: input.fetchImpl,
          fromAgentDid: inputReplay.fromAgentDid,
          groupId: inputReplay.groupId,
          deliveryWebhookHookUrl: input.deliveryWebhookHookUrl,
          deliveryWebhookToken: input.getCurrentDeliveryWebhookHookToken(),
          payload: inputReplay.payload,
          conversationId: inputReplay.conversationId,
          replyTo: inputReplay.replyTo,
          requestId: inputReplay.requestId,
          senderProfile: inputReplay.senderProfile,
          shutdownSignal: input.runtimeShutdownSignal,
          toAgentDid: inputReplay.toAgentDid,
        });
        return;
      } catch (error) {
        if (
          error instanceof LocalDeliveryWebhookDeliveryError &&
          error.code === "RUNTIME_STOPPING"
        ) {
          throw error;
        }

        const retryable =
          error instanceof LocalDeliveryWebhookDeliveryError
            ? error.retryable
            : true;
        const authRejected =
          error instanceof LocalDeliveryWebhookDeliveryError &&
          error.code === "HOOK_AUTH_REJECTED";

        if (authRejected) {
          const previousToken = input.getCurrentDeliveryWebhookHookToken();
          await input.syncDeliveryWebhookHookToken("auth_rejected");
          const tokenChanged =
            input.getCurrentDeliveryWebhookHookToken() !== previousToken;
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
      deliveryWebhookGateway: {
        url: sanitizedDeliveryWebhookProbeUrl,
        reachable: input.deliveryWebhookGatewayProbeStatus.reachable,
        lastCheckedAt: input.deliveryWebhookGatewayProbeStatus.lastCheckedAt,
        lastSuccessAt: input.deliveryWebhookGatewayProbeStatus.lastSuccessAt,
        lastFailureReason:
          input.deliveryWebhookGatewayProbeStatus.lastFailureReason,
      },
      deliveryWebhookHook: {
        url: sanitizedDeliveryWebhookHookUrl,
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

      await input.syncDeliveryWebhookHookToken("batch");
      if (!input.deliveryWebhookGatewayProbeStatus.reachable) {
        input.logger.info(
          "connector.inbound.replay_skipped_gateway_unreachable",
          {
            pendingCount: dueItems.length,
            deliveryWebhookBaseUrl: input.deliveryWebhookProbeUrl,
            lastFailureReason:
              input.deliveryWebhookGatewayProbeStatus.lastFailureReason,
          },
        );
        return;
      }

      const laneItems = groupDueItemsByLane(dueItems);
      const senderProfilesByDid = await input.loadSenderProfilesByDid();
      await Promise.all(
        laneItems.map(async (lane) => {
          for (const pending of lane) {
            inboundReplayStatus.lastAttemptAt = nowIso();
            try {
              await deliverToDeliveryWebhookHookWithRetry({
                fromAgentDid: pending.fromAgentDid,
                groupId: pending.groupId,
                requestId: pending.requestId,
                payload: pending.payload,
                conversationId: pending.conversationId,
                replyTo: pending.replyTo,
                senderProfile: senderProfilesByDid.get(pending.fromAgentDid),
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

              try {
                await input.postDeliveryReceipt({
                  requestId: pending.requestId,
                  senderAgentDid: pending.fromAgentDid,
                  recipientAgentDid: pending.toAgentDid,
                  status: "delivered_to_webhook",
                });
              } catch (error) {
                input.logger.warn("connector.inbound.delivery_receipt_failed", {
                  requestId: pending.requestId,
                  reason: sanitizeErrorReason(error),
                  status: "delivered_to_webhook",
                });
              }
            } catch (error) {
              if (
                error instanceof LocalDeliveryWebhookDeliveryError &&
                error.code === "RUNTIME_STOPPING"
              ) {
                input.logger.info("connector.inbound.replay_stopped", {
                  requestId: pending.requestId,
                });
                return;
              }

              const reason = sanitizeErrorReason(error);
              const retryable =
                error instanceof LocalDeliveryWebhookDeliveryError
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

              if (markResult.movedToDeadLetter) {
                try {
                  await input.postDeliveryReceipt({
                    requestId: pending.requestId,
                    senderAgentDid: pending.fromAgentDid,
                    recipientAgentDid: pending.toAgentDid,
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
    } catch (error) {
      if (!input.isRuntimeStopping()) {
        const reason = sanitizeErrorReason(error);
        inboundReplayStatus.lastReplayError = reason;
        inboundReplayStatus.lastAttemptStatus = "failed";
        input.logger.warn("connector.inbound.replay_loop_failed", {
          reason,
        });
      }
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
