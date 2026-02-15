import { AppError, type Logger } from "@clawdentity/sdk";
import type { Context } from "hono";
import type { ProxyRequestVariables } from "./auth-middleware.js";

const AGENT_HOOK_PATH = "/hooks/agent";
export const DEFAULT_AGENT_HOOK_TIMEOUT_MS = 10_000;

export type AgentHookRuntimeOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
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

export function createAgentHookHandler(
  options: CreateAgentHookHandlerOptions,
): (c: ProxyContext) => Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_AGENT_HOOK_TIMEOUT_MS;
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
