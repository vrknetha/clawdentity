import { AppError, type Logger } from "@clawdentity/sdk";
import type { Context } from "hono";
import type { ProxyRequestVariables } from "./auth-middleware.js";

const AGENT_HOOK_PATH = "hooks/agent";
export const DEFAULT_AGENT_HOOK_TIMEOUT_MS = 10_000;
const MAX_AGENT_DID_LENGTH = 160;
const MAX_OWNER_DID_LENGTH = 160;
const MAX_ISSUER_LENGTH = 200;
const MAX_AIT_JTI_LENGTH = 64;

export type AgentHookRuntimeOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  injectIdentityIntoMessage?: boolean;
};

type CreateAgentHookHandlerOptions = AgentHookRuntimeOptions & {
  logger: Logger;
  openclawBaseUrl: string;
  openclawHookToken: string;
};

type ProxyContext = Context<{
  Variables: ProxyRequestVariables;
}>;

function isJsonContentType(contentTypeHeader: string | undefined): boolean {
  if (typeof contentTypeHeader !== "string") {
    return false;
  }

  const [mediaType] = contentTypeHeader.split(";");
  return mediaType.trim().toLowerCase() === "application/json";
}

function toOpenclawHookUrl(openclawBaseUrl: string): string {
  const normalizedBase = openclawBaseUrl.endsWith("/")
    ? openclawBaseUrl
    : `${openclawBaseUrl}/`;
  return new URL(AGENT_HOOK_PATH, normalizedBase).toString();
}

function toErrorName(error: unknown): string {
  if (error instanceof Error && error.name.trim().length > 0) {
    return error.name;
  }

  return "unknown";
}

function isAbortError(error: unknown): boolean {
  return toErrorName(error) === "AbortError";
}

function stripControlChars(value: string): string {
  let result = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    if ((code >= 0 && code <= 31) || code === 127) {
      continue;
    }
    result += char;
  }

  return result;
}

function sanitizeIdentityField(value: string, maxLength: number): string {
  const sanitized = stripControlChars(value).replaceAll(/\s+/g, " ").trim();

  if (sanitized.length === 0) {
    return "unknown";
  }

  return sanitized.slice(0, maxLength);
}

function buildIdentityBlock(
  auth: NonNullable<ProxyRequestVariables["auth"]>,
): string {
  return [
    "[Clawdentity Identity]",
    `agentDid: ${sanitizeIdentityField(auth.agentDid, MAX_AGENT_DID_LENGTH)}`,
    `ownerDid: ${sanitizeIdentityField(auth.ownerDid, MAX_OWNER_DID_LENGTH)}`,
    `issuer: ${sanitizeIdentityField(auth.issuer, MAX_ISSUER_LENGTH)}`,
    `aitJti: ${sanitizeIdentityField(auth.aitJti, MAX_AIT_JTI_LENGTH)}`,
  ].join("\n");
}

function injectIdentityBlockIntoPayload(
  payload: unknown,
  auth: ProxyRequestVariables["auth"],
): unknown {
  if (auth === undefined || typeof payload !== "object" || payload === null) {
    return payload;
  }

  if (!("message" in payload)) {
    return payload;
  }

  const message = (payload as { message?: unknown }).message;
  if (typeof message !== "string") {
    return payload;
  }

  return {
    ...(payload as Record<string, unknown>),
    message: `${buildIdentityBlock(auth)}\n\n${message}`,
  };
}

export function createAgentHookHandler(
  options: CreateAgentHookHandlerOptions,
): (c: ProxyContext) => Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_AGENT_HOOK_TIMEOUT_MS;
  const injectIdentityIntoMessage = options.injectIdentityIntoMessage ?? false;
  const hookUrl = toOpenclawHookUrl(options.openclawBaseUrl);

  return async (c) => {
    if (!isJsonContentType(c.req.header("content-type"))) {
      throw new AppError({
        code: "PROXY_HOOK_UNSUPPORTED_MEDIA_TYPE",
        message: "Content-Type must be application/json",
        status: 415,
        expose: true,
      });
    }

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      throw new AppError({
        code: "PROXY_HOOK_INVALID_JSON",
        message: "Request body must be valid JSON",
        status: 400,
        expose: true,
      });
    }

    if (injectIdentityIntoMessage) {
      payload = injectIdentityBlockIntoPayload(payload, c.get("auth"));
    }

    const requestId = c.get("requestId");
    const startedAt = Date.now();
    const controller = new AbortController();
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetchImpl(hookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openclaw-token": options.openclawHookToken,
          "x-request-id": requestId,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut || isAbortError(error)) {
        options.logger.warn("proxy.hooks.agent.timeout", {
          requestId,
          timeoutMs,
        });
        throw new AppError({
          code: "PROXY_HOOK_UPSTREAM_TIMEOUT",
          message: "OpenClaw hook upstream request timed out",
          status: 504,
        });
      }

      options.logger.warn("proxy.hooks.agent.network_error", {
        requestId,
        errorName: toErrorName(error),
      });
      throw new AppError({
        code: "PROXY_HOOK_UPSTREAM_UNAVAILABLE",
        message: "OpenClaw hook upstream request failed",
        status: 502,
      });
    } finally {
      clearTimeout(timeoutHandle);
    }

    options.logger.info("proxy.hooks.agent.forwarded", {
      requestId,
      upstreamStatus: upstreamResponse.status,
      durationMs: Date.now() - startedAt,
    });

    const responseBody = await upstreamResponse.text();
    const responseHeaders: Record<string, string> = {};
    const upstreamContentType = upstreamResponse.headers.get("content-type");
    if (typeof upstreamContentType === "string") {
      responseHeaders["content-type"] = upstreamContentType;
    }

    return c.body(
      responseBody,
      upstreamResponse.status as 200,
      responseHeaders,
    );
  };
}
