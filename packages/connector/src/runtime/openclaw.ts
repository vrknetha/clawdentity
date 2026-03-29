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
  fetchImpl: typeof fetch;
  fromAgentDid: string;
  openclawHookToken?: string;
  openclawHookUrl: string;
  payload: unknown;
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
  applyOpenclawSenderProfileHeaders({
    headers,
    senderProfile: input.senderProfile,
  });

  try {
    const response = await input.fetchImpl(input.openclawHookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(input.payload),
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
