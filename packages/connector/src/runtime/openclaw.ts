import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "@clawdentity/sdk";
import { DEFAULT_OPENCLAW_DELIVER_TIMEOUT_MS } from "../constants.js";
import type { ReceiptFrame } from "../frames.js";
import {
  applyOpenclawSenderProfileHeaders,
  type OpenclawSenderProfile,
} from "../openclaw-headers.js";
import { OPENCLAW_RELAY_RUNTIME_FILE_NAME } from "./constants.js";
import { LocalOpenclawDeliveryError, sanitizeErrorReason } from "./errors.js";
import { isRecord } from "./parse.js";

export async function waitWithAbort(input: {
  delayMs: number;
  signal: AbortSignal;
}): Promise<void> {
  if (input.signal.aborted) {
    throw new LocalOpenclawDeliveryError({
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
        new LocalOpenclawDeliveryError({
          code: "RUNTIME_STOPPING",
          message: "Connector runtime is stopping",
          retryable: false,
        }),
      );
    };

    input.signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function readOpenclawHookTokenFromRelayRuntimeConfig(input: {
  configDir: string;
  logger: Logger;
}): Promise<string | undefined> {
  const runtimeConfigPath = join(
    input.configDir,
    OPENCLAW_RELAY_RUNTIME_FILE_NAME,
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

    input.logger.warn("connector.runtime.openclaw_relay_config_read_failed", {
      runtimeConfigPath,
      reason: sanitizeErrorReason(error),
    });
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    input.logger.warn("connector.runtime.openclaw_relay_config_invalid_json", {
      runtimeConfigPath,
    });
    return undefined;
  }

  if (!isRecord(parsed)) {
    return undefined;
  }

  const tokenValue = parsed.openclawHookToken;
  if (typeof tokenValue !== "string") {
    return undefined;
  }

  const trimmed = tokenValue.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export async function deliverToOpenclawHook(input: {
  conversationId?: string;
  fetchImpl: typeof fetch;
  fromAgentDid: string;
  groupId?: string;
  openclawHookToken?: string;
  openclawHookUrl: string;
  payload: unknown;
  replyTo?: string;
  requestId: string;
  senderProfile?: OpenclawSenderProfile;
  shutdownSignal: AbortSignal;
  toAgentDid: string;
}): Promise<void> {
  const timeoutSignal = AbortSignal.timeout(
    DEFAULT_OPENCLAW_DELIVER_TIMEOUT_MS,
  );
  const signal = AbortSignal.any([input.shutdownSignal, timeoutSignal]);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-clawdentity-agent-did": input.fromAgentDid,
    "x-clawdentity-to-agent-did": input.toAgentDid,
    "x-clawdentity-verified": "true",
    "x-request-id": input.requestId,
  };
  if (input.openclawHookToken !== undefined) {
    headers["x-openclaw-token"] = input.openclawHookToken;
  }
  if (typeof input.groupId === "string" && input.groupId.trim().length > 0) {
    headers["x-clawdentity-group-id"] = input.groupId.trim();
  }
  applyOpenclawSenderProfileHeaders({
    headers,
    senderProfile: input.senderProfile,
  });

  const hookPayload = buildOpenclawHookPayload({
    conversationId: input.conversationId,
    fromAgentDid: input.fromAgentDid,
    groupId: input.groupId,
    hookUrl: input.openclawHookUrl,
    payload: input.payload,
    replyTo: input.replyTo,
    requestId: input.requestId,
    senderProfile: input.senderProfile,
    toAgentDid: input.toAgentDid,
  });

  try {
    const response = await input.fetchImpl(input.openclawHookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(hookPayload),
      signal,
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
        code:
          response.status === 401 || response.status === 403
            ? "HOOK_AUTH_REJECTED"
            : undefined,
      });
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      if (input.shutdownSignal.aborted) {
        throw new LocalOpenclawDeliveryError({
          code: "RUNTIME_STOPPING",
          message: "Connector runtime is stopping",
          retryable: false,
        });
      }
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
  }
}

function parseOptionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractMessage(payload: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }
  if (isRecord(payload)) {
    const content = parseOptionalNonEmptyString(payload.content);
    if (content !== undefined) {
      return content;
    }
    const message = parseOptionalNonEmptyString(payload.message);
    if (message !== undefined) {
      return message;
    }
    const text = parseOptionalNonEmptyString(payload.text);
    if (text !== undefined) {
      return text;
    }
  }
  return JSON.stringify(payload ?? null);
}

function resolveSenderAgentName(input: {
  payload: unknown;
  senderProfile?: OpenclawSenderProfile;
}): string | undefined {
  return (
    parseOptionalNonEmptyString(input.senderProfile?.agentName) ??
    (isRecord(input.payload)
      ? parseOptionalNonEmptyString(input.payload.senderAgentName)
      : undefined)
  );
}

function resolveSenderDisplayName(input: {
  payload: unknown;
  senderProfile?: OpenclawSenderProfile;
}): string | undefined {
  return (
    parseOptionalNonEmptyString(input.senderProfile?.displayName) ??
    (isRecord(input.payload)
      ? parseOptionalNonEmptyString(input.payload.senderDisplayName)
      : undefined)
  );
}

function resolveGroupName(input: {
  groupId?: string;
  payload: unknown;
}): string | undefined {
  return (
    (isRecord(input.payload)
      ? parseOptionalNonEmptyString(input.payload.groupName)
      : undefined) ?? parseOptionalNonEmptyString(input.groupId)
  );
}

function renderSenderLabel(input: {
  senderAgentName?: string;
  senderDisplayName?: string;
  senderDid: string;
}): string {
  if (input.senderAgentName && input.senderDisplayName) {
    return `${input.senderAgentName} (${input.senderDisplayName})`;
  }
  return input.senderAgentName ?? input.senderDisplayName ?? input.senderDid;
}

function renderWakeText(input: {
  conversationId?: string;
  groupId?: string;
  groupName?: string;
  message: string;
  replyTo?: string;
  requestId: string;
  senderAgentName?: string;
  senderDid: string;
  senderDisplayName?: string;
}): string {
  const senderLabel = renderSenderLabel({
    senderAgentName: input.senderAgentName,
    senderDisplayName: input.senderDisplayName,
    senderDid: input.senderDid,
  });
  const isGroupMessage =
    parseOptionalNonEmptyString(input.groupId) !== undefined;
  const firstLine = isGroupMessage
    ? `Message in ${input.groupName ?? input.groupId} from ${senderLabel}`
    : `Message from ${senderLabel}`;
  const lines = [firstLine];
  if (input.message.trim().length > 0) {
    lines.push("", input.message);
  }
  lines.push("", `Request ID: ${input.requestId}`);
  if (parseOptionalNonEmptyString(input.conversationId)) {
    lines.push(`Conversation ID: ${input.conversationId}`);
  }
  if (parseOptionalNonEmptyString(input.replyTo)) {
    lines.push(`Reply To: ${input.replyTo}`);
  }
  return lines.join("\n");
}

function buildOpenclawHookPayload(input: {
  conversationId?: string;
  fromAgentDid: string;
  groupId?: string;
  hookUrl: string;
  payload: unknown;
  replyTo?: string;
  requestId: string;
  senderProfile?: OpenclawSenderProfile;
  toAgentDid: string;
}): unknown {
  const hookPath = new URL(input.hookUrl).pathname;
  const message = extractMessage(input.payload);
  const senderAgentName = resolveSenderAgentName({
    payload: input.payload,
    senderProfile: input.senderProfile,
  });
  const senderDisplayName = resolveSenderDisplayName({
    payload: input.payload,
    senderProfile: input.senderProfile,
  });
  const groupId = parseOptionalNonEmptyString(input.groupId);
  const groupName = resolveGroupName({
    groupId,
    payload: input.payload,
  });
  const isGroupMessage = groupId !== undefined;

  if (hookPath === "/hooks/wake") {
    const wakeText = renderWakeText({
      conversationId: input.conversationId,
      groupId,
      groupName,
      message,
      replyTo: input.replyTo,
      requestId: input.requestId,
      senderAgentName,
      senderDid: input.fromAgentDid,
      senderDisplayName,
    });
    const wakePayload: Record<string, unknown> = {
      message: wakeText,
      text: wakeText,
      mode: "now",
    };
    const sessionId = isRecord(input.payload)
      ? parseOptionalNonEmptyString(input.payload.sessionId)
      : undefined;
    if (sessionId) {
      wakePayload.sessionId = sessionId;
    }
    return wakePayload;
  }

  return {
    message,
    senderDid: input.fromAgentDid,
    senderAgentName: senderAgentName ?? null,
    senderDisplayName: senderDisplayName ?? null,
    recipientDid: input.toAgentDid,
    groupId: groupId ?? null,
    groupName: groupName ?? null,
    isGroupMessage,
    requestId: input.requestId,
    metadata: {
      conversationId: input.conversationId ?? null,
      replyTo: input.replyTo ?? null,
      payload: input.payload ?? null,
    },
  };
}

function renderReceiptSummary(receipt: ReceiptFrame): string {
  const lines = [
    `Clawdentity delivery receipt: ${receipt.status}`,
    "",
    `Request ID: ${receipt.originalFrameId}`,
    `Recipient DID: ${receipt.toAgentDid}`,
  ];
  if (receipt.reason) {
    lines.push(`Reason: ${receipt.reason}`);
  }
  lines.push(`Timestamp: ${receipt.ts}`);
  return lines.join("\n");
}

function buildReceiptHookPayload(input: {
  hookPathname: string;
  receipt: ReceiptFrame;
}): unknown {
  const summary = renderReceiptSummary(input.receipt);
  const payload = {
    type: "clawdentity:receipt",
    originalFrameId: input.receipt.originalFrameId,
    toAgentDid: input.receipt.toAgentDid,
    status: input.receipt.status,
    reason: input.receipt.reason,
    timestamp: input.receipt.ts,
  };

  if (input.hookPathname === "/hooks/wake") {
    return {
      ...payload,
      text: summary,
      message: summary,
      mode: "now",
      metadata: {
        receipt: payload,
      },
    };
  }

  return {
    ...payload,
    message: summary,
    content: summary,
    metadata: {
      receipt: payload,
    },
  };
}

export async function deliverReceiptToOpenclawHook(input: {
  fetchImpl: typeof fetch;
  openclawHookToken?: string;
  openclawHookUrl: string;
  receipt: ReceiptFrame;
  shutdownSignal: AbortSignal;
}): Promise<void> {
  const timeoutSignal = AbortSignal.timeout(
    DEFAULT_OPENCLAW_DELIVER_TIMEOUT_MS,
  );
  const signal = AbortSignal.any([input.shutdownSignal, timeoutSignal]);

  const hookUrl = new URL(input.openclawHookUrl);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-clawdentity-content-type": "application/vnd.clawdentity.receipt+json",
    "x-clawdentity-to-agent-did": input.receipt.toAgentDid,
    "x-clawdentity-verified": "true",
    "x-request-id": input.receipt.originalFrameId,
  };
  if (input.openclawHookToken !== undefined) {
    headers["x-openclaw-token"] = input.openclawHookToken;
  }

  try {
    const response = await input.fetchImpl(input.openclawHookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(
        buildReceiptHookPayload({
          hookPathname: hookUrl.pathname,
          receipt: input.receipt,
        }),
      ),
      signal,
    });
    if (!response.ok) {
      throw new LocalOpenclawDeliveryError({
        message: `Local OpenClaw hook rejected receipt with status ${response.status}`,
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
        throw new LocalOpenclawDeliveryError({
          code: "RUNTIME_STOPPING",
          message: "Connector runtime is stopping",
          retryable: false,
        });
      }
      throw new LocalOpenclawDeliveryError({
        message: "Local OpenClaw receipt hook request timed out",
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
  }
}
