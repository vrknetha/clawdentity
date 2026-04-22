import type { Logger } from "@clawdentity/sdk";
import {
  applyDeliveryWebhookSenderProfileHeaders,
  type DeliveryWebhookSenderProfile,
} from "../deliveryWebhook-headers.js";
import { buildDeliveryWebhookHookPayload } from "../deliveryWebhook-payload.js";
import type { DeliverFrame } from "../frames.js";
import { isAbortError, sanitizeErrorReason, wait } from "./helpers.js";
import { computeNextBackoffDelayMs } from "./retry.js";

class LocalDeliveryWebhookDeliveryError extends Error {
  readonly retryable: boolean;

  constructor(input: { message: string; retryable: boolean }) {
    super(input.message);
    this.name = "LocalDeliveryWebhookDeliveryError";
    this.retryable = input.retryable;
  }
}

function isRetryableDeliveryWebhookDeliveryError(error: unknown): boolean {
  return (
    error instanceof LocalDeliveryWebhookDeliveryError &&
    error.retryable === true
  );
}

function parseOptionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export class LocalDeliveryWebhookDeliveryClient {
  private readonly fetchImpl: typeof fetch;
  private readonly deliveryWebhookHookUrl: string;
  private readonly deliveryWebhookToken: string | undefined;
  private readonly deliveryWebhookDeliverTimeoutMs: number;
  private readonly deliveryWebhookDeliverMaxAttempts: number;
  private readonly deliveryWebhookDeliverRetryInitialDelayMs: number;
  private readonly deliveryWebhookDeliverRetryMaxDelayMs: number;
  private readonly deliveryWebhookDeliverRetryBackoffFactor: number;
  private readonly deliveryWebhookDeliverRetryBudgetMs: number;
  private readonly resolveInboundSenderProfile:
    | ((
        fromAgentDid: string,
      ) =>
        | DeliveryWebhookSenderProfile
        | Promise<DeliveryWebhookSenderProfile | undefined>
        | undefined)
    | undefined;
  private readonly now: () => number;
  private readonly logger: Logger;

  constructor(input: {
    fetchImpl: typeof fetch;
    deliveryWebhookHookUrl: string;
    deliveryWebhookToken: string | undefined;
    deliveryWebhookDeliverTimeoutMs: number;
    deliveryWebhookDeliverMaxAttempts: number;
    deliveryWebhookDeliverRetryInitialDelayMs: number;
    deliveryWebhookDeliverRetryMaxDelayMs: number;
    deliveryWebhookDeliverRetryBackoffFactor: number;
    deliveryWebhookDeliverRetryBudgetMs: number;
    resolveInboundSenderProfile:
      | ((
          fromAgentDid: string,
        ) =>
          | DeliveryWebhookSenderProfile
          | Promise<DeliveryWebhookSenderProfile | undefined>
          | undefined)
      | undefined;
    now: () => number;
    logger: Logger;
  }) {
    this.fetchImpl = input.fetchImpl;
    this.deliveryWebhookHookUrl = input.deliveryWebhookHookUrl;
    this.deliveryWebhookToken = input.deliveryWebhookToken;
    this.deliveryWebhookDeliverTimeoutMs =
      input.deliveryWebhookDeliverTimeoutMs;
    this.deliveryWebhookDeliverMaxAttempts =
      input.deliveryWebhookDeliverMaxAttempts;
    this.deliveryWebhookDeliverRetryInitialDelayMs =
      input.deliveryWebhookDeliverRetryInitialDelayMs;
    this.deliveryWebhookDeliverRetryMaxDelayMs =
      input.deliveryWebhookDeliverRetryMaxDelayMs;
    this.deliveryWebhookDeliverRetryBackoffFactor =
      input.deliveryWebhookDeliverRetryBackoffFactor;
    this.deliveryWebhookDeliverRetryBudgetMs =
      input.deliveryWebhookDeliverRetryBudgetMs;
    this.resolveInboundSenderProfile = input.resolveInboundSenderProfile;
    this.now = input.now;
    this.logger = input.logger;
  }

  async deliverWithRetry(
    frame: DeliverFrame,
    shouldContinue: () => boolean,
  ): Promise<void> {
    let senderProfile: DeliveryWebhookSenderProfile | undefined;
    if (this.resolveInboundSenderProfile !== undefined) {
      try {
        senderProfile = await this.resolveInboundSenderProfile(
          frame.fromAgentDid,
        );
      } catch (error) {
        this.logger.warn(
          "connector.deliveryWebhook.sender_profile_lookup_failed",
          {
            fromAgentDid: frame.fromAgentDid,
            reason: sanitizeErrorReason(error),
          },
        );
      }
    }

    const startedAt = this.now();
    let attempt = 1;
    let retryDelayMs = this.deliveryWebhookDeliverRetryInitialDelayMs;

    while (true) {
      try {
        await this.deliverOnce(frame, senderProfile);
        return;
      } catch (error) {
        const retryable = isRetryableDeliveryWebhookDeliveryError(error);
        const attemptsRemaining =
          attempt < this.deliveryWebhookDeliverMaxAttempts;
        const elapsedMs = this.now() - startedAt;
        const hasBudgetForRetry =
          elapsedMs + retryDelayMs + this.deliveryWebhookDeliverTimeoutMs <=
          this.deliveryWebhookDeliverRetryBudgetMs;
        const shouldRetry =
          retryable &&
          attemptsRemaining &&
          hasBudgetForRetry &&
          shouldContinue();

        this.logger.warn("connector.deliveryWebhook.deliver_failed", {
          ackId: frame.id,
          attempt,
          retryable,
          shouldRetry,
          reason: sanitizeErrorReason(error),
        });

        if (!shouldRetry) {
          throw error;
        }

        await wait(retryDelayMs);
        retryDelayMs = computeNextBackoffDelayMs({
          currentDelayMs: retryDelayMs,
          maxDelayMs: this.deliveryWebhookDeliverRetryMaxDelayMs,
          backoffFactor: this.deliveryWebhookDeliverRetryBackoffFactor,
        });
        attempt += 1;
      }
    }
  }

  private async deliverOnce(
    frame: DeliverFrame,
    senderProfile: DeliveryWebhookSenderProfile | undefined,
  ): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.deliveryWebhookDeliverTimeoutMs);

    const headers: Record<string, string> = {
      "content-type": "application/vnd.clawdentity.delivery+json",
      "x-clawdentity-agent-did": frame.fromAgentDid,
      "x-clawdentity-to-agent-did": frame.toAgentDid,
      "x-clawdentity-verified": "true",
      "x-request-id": frame.id,
    };

    if (this.deliveryWebhookToken !== undefined) {
      headers["x-deliveryWebhook-token"] = this.deliveryWebhookToken;
    }
    const groupId = parseOptionalNonEmptyString(frame.groupId);
    if (groupId) {
      headers["x-clawdentity-group-id"] = groupId;
    }
    applyDeliveryWebhookSenderProfileHeaders({
      headers,
      senderProfile,
    });

    try {
      const response = await this.fetchImpl(this.deliveryWebhookHookUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(
          buildDeliveryWebhookHookPayload({
            contentType: frame.contentType,
            deliverySource: frame.deliverySource,
            deliveryTimestamp: frame.ts,
            payload: frame.payload,
            senderDid: frame.fromAgentDid,
            toAgentDid: frame.toAgentDid,
            requestId: frame.id,
            conversationId: frame.conversationId,
            replyTo: frame.replyTo,
            groupId: frame.groupId,
            senderProfile,
          }),
        ),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new LocalDeliveryWebhookDeliveryError({
          message: `Local delivery webhook rejected payload with status ${response.status}`,
          retryable:
            response.status === 401 ||
            response.status === 403 ||
            response.status >= 500 ||
            response.status === 404 ||
            response.status === 429,
        });
      }
    } catch (error) {
      if (isAbortError(error)) {
        throw new LocalDeliveryWebhookDeliveryError({
          message: "Local delivery webhook request timed out",
          retryable: true,
        });
      }

      if (error instanceof LocalDeliveryWebhookDeliveryError) {
        throw error;
      }

      throw new LocalDeliveryWebhookDeliveryError({
        message: sanitizeErrorReason(error),
        retryable: true,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
