import {
  toOpenclawHookUrl as buildOpenclawHookUrl,
  sanitizeErrorReason as sanitizeReason,
} from "@clawdentity/common";
import type { ConnectorClientOptions, ConnectorWebSocket } from "./types.js";

export const WS_READY_STATE_CONNECTING = 0;

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function resolveWebSocketFactory(
  webSocketFactory: ConnectorClientOptions["webSocketFactory"],
): (url: string, headers: Record<string, string>) => ConnectorWebSocket {
  if (webSocketFactory !== undefined) {
    return webSocketFactory;
  }

  if (typeof WebSocket !== "function") {
    throw new Error("WebSocket implementation is required");
  }

  return (_url: string, headers: Record<string, string>) => {
    if (Object.keys(headers).length > 0) {
      throw new Error(
        "Connection headers require a custom webSocketFactory implementation",
      );
    }

    return new WebSocket(_url) as ConnectorWebSocket;
  };
}

export function toOpenclawHookUrl(baseUrl: string, hookPath: string): string {
  return buildOpenclawHookUrl(baseUrl, hookPath);
}

export function sanitizeErrorReason(error: unknown): string {
  return sanitizeReason(error, {
    fallback: "Unknown delivery error",
    maxLength: 200,
  });
}

export function normalizeConnectionHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  if (headers === undefined) {
    return {};
  }

  const normalized: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.trim();
    const value = rawValue.trim();
    if (key.length === 0 || value.length === 0) {
      continue;
    }
    normalized[key] = value;
  }

  return normalized;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function readMessageEventData(event: unknown): unknown {
  if (!isObject(event)) {
    return undefined;
  }

  return event.data;
}

export function readCloseEvent(event: unknown): {
  code: number;
  reason: string;
  wasClean: boolean;
} {
  if (!isObject(event)) {
    return {
      code: 1006,
      reason: "",
      wasClean: false,
    };
  }

  return {
    code: typeof event.code === "number" ? event.code : 1006,
    reason: typeof event.reason === "string" ? event.reason : "",
    wasClean: typeof event.wasClean === "boolean" ? event.wasClean : false,
  };
}

export function readUnexpectedResponseStatus(
  event: unknown,
): number | undefined {
  if (!isObject(event)) {
    return undefined;
  }

  if (typeof event.status === "number") {
    return event.status;
  }

  if (typeof event.statusCode === "number") {
    return event.statusCode;
  }

  const response = event.response;
  if (isObject(response)) {
    if (typeof response.status === "number") {
      return response.status;
    }
    if (typeof response.statusCode === "number") {
      return response.statusCode;
    }
  }

  return undefined;
}

export function readErrorEventReason(event: unknown): string {
  if (!isObject(event) || !("error" in event)) {
    return "WebSocket error";
  }

  return sanitizeErrorReason(event.error);
}

export async function wait(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
