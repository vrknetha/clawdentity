import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "@clawdentity/sdk";
import { DEFAULT_DELIVERY_WEBHOOK_DELIVER_TIMEOUT_MS } from "../constants.js";
import {
  applyDeliveryWebhookSenderProfileHeaders,
  type DeliveryWebhookSenderProfile,
} from "../deliveryWebhook-headers.js";
import { buildDeliveryWebhookHookPayload } from "../deliveryWebhook-payload.js";
import type { ReceiptFrame } from "../frames.js";
import { DELIVERY_WEBHOOK_RELAY_RUNTIME_FILE_NAME } from "./constants.js";
import {
  LocalDeliveryWebhookDeliveryError,
  sanitizeErrorReason,
} from "./errors.js";
import { isRecord } from "./parse.js";

export async function waitWithAbort(input: {
  delayMs: number;
  signal: AbortSignal;
}): Promise<void> {
  if (input.signal.aborted) {
    throw new LocalDeliveryWebhookDeliveryError({
      code: "RUNTIME_STOPPING",
      message: "Connector runtime is stopping",
      retryable: false,
    });
  }

  await new Promise<void>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      input.signal.removeEventListener("abort", onAbort);
      resolve();
    }, input.delayMs);

    const onAbort = () => {
      clearTimeout(timeoutHandle);
      input.signal.removeEventListener("abort", onAbort);
      reject(
        new LocalDeliveryWebhookDeliveryError({
          code: "RUNTIME_STOPPING",
          message: "Connector runtime is stopping",
          retryable: false,
        }),
      );
    };

    input.signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function readDeliveryWebhookHookTokenFromRelayRuntimeConfig(input: {
  configDir: string;
  logger: Logger;
}): Promise<string | undefined> {
  const runtimeConfigPath = join(
    input.configDir,
    DELIVERY_WEBHOOK_RELAY_RUNTIME_FILE_NAME,
  );
  let raw: string;
  try {
    raw = await readFile(runtimeConfigPath, "utf8");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return undefined;
    }

    input.logger.warn(
      "connector.runtime.deliveryWebhook_relay_config_read_failed",
      {
        runtimeConfigPath,
        reason: sanitizeErrorReason(error),
      },
    );
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    input.logger.warn(
      "connector.runtime.deliveryWebhook_relay_config_invalid_json",
      {
        runtimeConfigPath,
      },
    );
    return undefined;
  }

  if (!isRecord(parsed)) {
    return undefined;
  }

  const tokenValue = parsed.deliveryWebhookToken;
  if (typeof tokenValue !== "string") {
    return undefined;
  }

  const trimmed = tokenValue.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export async function deliverToDeliveryWebhookHook(input: {
  contentType?: string;
  conversationId?: string;
  deliverySource?: string;
  deliveryTimestamp?: string;
  groupName?: string;
  fetchImpl: typeof fetch;
  fromAgentDid: string;
  groupId?: string;
  deliveryWebhookToken?: string;
  deliveryWebhookHookUrl: string;
  payload: unknown;
  replyTo?: string;
  requestId: string;
  senderProfile?: DeliveryWebhookSenderProfile;
  shutdownSignal: AbortSignal;
  toAgentDid: string;
}): Promise<void> {
  const timeoutSignal = AbortSignal.timeout(
    DEFAULT_DELIVERY_WEBHOOK_DELIVER_TIMEOUT_MS,
  );
  const signal = AbortSignal.any([input.shutdownSignal, timeoutSignal]);

  const headers: Record<string, string> = {
    "content-type": "application/vnd.clawdentity.delivery+json",
    "x-clawdentity-agent-did": input.fromAgentDid,
    "x-clawdentity-to-agent-did": input.toAgentDid,
    "x-clawdentity-verified": "true",
    "x-request-id": input.requestId,
  };
  if (input.deliveryWebhookToken !== undefined) {
    headers["x-deliveryWebhook-token"] = input.deliveryWebhookToken;
  }
  if (typeof input.groupId === "string" && input.groupId.trim().length > 0) {
    headers["x-clawdentity-group-id"] = input.groupId.trim();
  }
  applyDeliveryWebhookSenderProfileHeaders({
    headers,
    senderProfile: input.senderProfile,
  });

  const hookPayload = buildDeliveryWebhookHookPayload({
    contentType: input.contentType,
    conversationId: input.conversationId,
    deliverySource: input.deliverySource,
    deliveryTimestamp: input.deliveryTimestamp,
    groupName: input.groupName,
    groupId: input.groupId,
    payload: input.payload,
    replyTo: input.replyTo,
    requestId: input.requestId,
    senderDid: input.fromAgentDid,
    senderProfile: input.senderProfile,
    toAgentDid: input.toAgentDid,
  });

  try {
    const response = await input.fetchImpl(input.deliveryWebhookHookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(hookPayload),
      signal,
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
        code:
          response.status === 401 || response.status === 403
            ? "HOOK_AUTH_REJECTED"
            : undefined,
      });
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      if (input.shutdownSignal.aborted) {
        throw new LocalDeliveryWebhookDeliveryError({
          code: "RUNTIME_STOPPING",
          message: "Connector runtime is stopping",
          retryable: false,
        });
      }
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
  }
}

function buildReceiptHookPayload(input: { receipt: ReceiptFrame }): unknown {
  const payload: Record<string, unknown> = {
    type: "clawdentity.receipt.v1",
    requestId: input.receipt.originalFrameId,
    toAgentDid: input.receipt.toAgentDid,
    status: input.receipt.status,
    relayMetadata: {
      timestamp: input.receipt.ts,
    },
  };
  if (
    typeof input.receipt.reason === "string" &&
    input.receipt.reason.length > 0
  ) {
    payload.reason = input.receipt.reason;
  }

  return payload;
}

export async function deliverReceiptToDeliveryWebhookHook(input: {
  fetchImpl: typeof fetch;
  deliveryWebhookToken?: string;
  deliveryWebhookHookUrl: string;
  receipt: ReceiptFrame;
  shutdownSignal: AbortSignal;
}): Promise<void> {
  const timeoutSignal = AbortSignal.timeout(
    DEFAULT_DELIVERY_WEBHOOK_DELIVER_TIMEOUT_MS,
  );
  const signal = AbortSignal.any([input.shutdownSignal, timeoutSignal]);

  const headers: Record<string, string> = {
    "content-type": "application/vnd.clawdentity.receipt+json",
    "x-clawdentity-to-agent-did": input.receipt.toAgentDid,
    "x-clawdentity-verified": "true",
    "x-request-id": input.receipt.originalFrameId,
  };
  if (input.deliveryWebhookToken !== undefined) {
    headers["x-deliveryWebhook-token"] = input.deliveryWebhookToken;
  }

  try {
    const response = await input.fetchImpl(input.deliveryWebhookHookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(
        buildReceiptHookPayload({
          receipt: input.receipt,
        }),
      ),
      signal,
    });
    if (!response.ok) {
      throw new LocalDeliveryWebhookDeliveryError({
        message: `Local delivery webhook rejected receipt with status ${response.status}`,
        retryable:
          response.status === 401 ||
          response.status === 403 ||
          response.status >= 500 ||
          response.status === 404 ||
          response.status === 429,
        code:
          response.status === 401 || response.status === 403
            ? "HOOK_AUTH_REJECTED"
            : undefined,
      });
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      if (input.shutdownSignal.aborted) {
        throw new LocalDeliveryWebhookDeliveryError({
          code: "RUNTIME_STOPPING",
          message: "Connector runtime is stopping",
          retryable: false,
        });
      }
      throw new LocalDeliveryWebhookDeliveryError({
        message: "Local delivery webhook receipt request timed out",
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
  }
}
