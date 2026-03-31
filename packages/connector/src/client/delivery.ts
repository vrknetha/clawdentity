import type { Logger } from "@clawdentity/sdk";
import type { DeliverFrame } from "../frames.js";
import {
  applyOpenclawSenderProfileHeaders,
  type OpenclawSenderProfile,
} from "../openclaw-headers.js";
import { buildOpenclawHookPayload } from "../openclaw-payload.js";
import { isAbortError, sanitizeErrorReason, wait } from "./helpers.js";
import { computeNextBackoffDelayMs } from "./retry.js";

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

function parseOptionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export class LocalOpenclawDeliveryClient {
  private readonly fetchImpl: typeof fetch;
  private readonly openclawHookUrl: string;
  private readonly openclawHookToken: string | undefined;
  private readonly openclawDeliverTimeoutMs: number;
  private readonly openclawDeliverMaxAttempts: number;
  private readonly openclawDeliverRetryInitialDelayMs: number;
  private readonly openclawDeliverRetryMaxDelayMs: number;
  private readonly openclawDeliverRetryBackoffFactor: number;
  private readonly openclawDeliverRetryBudgetMs: number;
  private readonly resolveInboundSenderProfile:
    | ((
        fromAgentDid: string,
      ) =>
        | OpenclawSenderProfile
        | Promise<OpenclawSenderProfile | undefined>
        | undefined)
    | undefined;
  private readonly now: () => number;
  private readonly logger: Logger;

  constructor(input: {
    fetchImpl: typeof fetch;
    openclawHookUrl: string;
    openclawHookToken: string | undefined;
    openclawDeliverTimeoutMs: number;
    openclawDeliverMaxAttempts: number;
    openclawDeliverRetryInitialDelayMs: number;
    openclawDeliverRetryMaxDelayMs: number;
    openclawDeliverRetryBackoffFactor: number;
    openclawDeliverRetryBudgetMs: number;
    resolveInboundSenderProfile:
      | ((
          fromAgentDid: string,
        ) =>
          | OpenclawSenderProfile
          | Promise<OpenclawSenderProfile | undefined>
          | undefined)
      | undefined;
    now: () => number;
    logger: Logger;
  }) {
    this.fetchImpl = input.fetchImpl;
    this.openclawHookUrl = input.openclawHookUrl;
    this.openclawHookToken = input.openclawHookToken;
    this.openclawDeliverTimeoutMs = input.openclawDeliverTimeoutMs;
    this.openclawDeliverMaxAttempts = input.openclawDeliverMaxAttempts;
    this.openclawDeliverRetryInitialDelayMs =
      input.openclawDeliverRetryInitialDelayMs;
    this.openclawDeliverRetryMaxDelayMs = input.openclawDeliverRetryMaxDelayMs;
    this.openclawDeliverRetryBackoffFactor =
      input.openclawDeliverRetryBackoffFactor;
    this.openclawDeliverRetryBudgetMs = input.openclawDeliverRetryBudgetMs;
    this.resolveInboundSenderProfile = input.resolveInboundSenderProfile;
    this.now = input.now;
    this.logger = input.logger;
  }

  async deliverWithRetry(
    frame: DeliverFrame,
    shouldContinue: () => boolean,
  ): Promise<void> {
    let senderProfile: OpenclawSenderProfile | undefined;
    if (this.resolveInboundSenderProfile !== undefined) {
      try {
        senderProfile = await this.resolveInboundSenderProfile(
          frame.fromAgentDid,
        );
      } catch (error) {
        this.logger.warn("connector.openclaw.sender_profile_lookup_failed", {
          fromAgentDid: frame.fromAgentDid,
          reason: sanitizeErrorReason(error),
        });
      }
    }

    const startedAt = this.now();
    let attempt = 1;
    let retryDelayMs = this.openclawDeliverRetryInitialDelayMs;

    while (true) {
      try {
        await this.deliverOnce(frame, senderProfile);
        return;
      } catch (error) {
        const retryable = isRetryableOpenclawDeliveryError(error);
        const attemptsRemaining = attempt < this.openclawDeliverMaxAttempts;
        const elapsedMs = this.now() - startedAt;
        const hasBudgetForRetry =
          elapsedMs + retryDelayMs + this.openclawDeliverTimeoutMs <=
          this.openclawDeliverRetryBudgetMs;
        const shouldRetry =
          retryable &&
          attemptsRemaining &&
          hasBudgetForRetry &&
          shouldContinue();

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

        await wait(retryDelayMs);
        retryDelayMs = computeNextBackoffDelayMs({
          currentDelayMs: retryDelayMs,
          maxDelayMs: this.openclawDeliverRetryMaxDelayMs,
          backoffFactor: this.openclawDeliverRetryBackoffFactor,
        });
        attempt += 1;
      }
    }
  }

  private async deliverOnce(
    frame: DeliverFrame,
    senderProfile: OpenclawSenderProfile | undefined,
  ): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.openclawDeliverTimeoutMs);

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-clawdentity-agent-did": frame.fromAgentDid,
      "x-clawdentity-to-agent-did": frame.toAgentDid,
      "x-clawdentity-verified": "true",
      "x-request-id": frame.id,
    };

    if (this.openclawHookToken !== undefined) {
      headers["x-openclaw-token"] = this.openclawHookToken;
    }
    const groupId = parseOptionalNonEmptyString(frame.groupId);
    if (groupId) {
      headers["x-clawdentity-group-id"] = groupId;
    }
    applyOpenclawSenderProfileHeaders({
      headers,
      senderProfile,
    });

    try {
      const response = await this.fetchImpl(this.openclawHookUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(
          buildOpenclawHookPayload({
            hookUrl: this.openclawHookUrl,
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
        throw new LocalOpenclawDeliveryError({
          message: `Local OpenClaw hook rejected payload with status ${response.status}`,
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
}
