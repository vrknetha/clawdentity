import { createLogger } from "@clawdentity/sdk";
import {
  AgentRelaySession,
  type AgentRelaySessionNamespace,
  RelaySessionDeliveryError,
} from "./agent-relay-session.js";
import {
  type ProxyConfig,
  ProxyConfigError,
  parseProxyConfig,
} from "./config.js";
import { resolveProxyVersion, resolveProxyVersionSource } from "./index.js";
import { ProxyTrustState } from "./proxy-trust-state.js";
import type { ProxyTrustStateNamespace } from "./proxy-trust-store.js";
import {
  DELIVERY_RECEIPT_EVENT_TYPE,
  handleReceiptQueueEvent,
  parseReceiptQueueEvent,
} from "./queue-consumer/receipt-events.js";
import { createProxyApp, type ProxyApp } from "./server.js";
import { resolveWorkerTrustStore } from "./trust-store-backend.js";

export type ProxyWorkerBindings = {
  LISTEN_PORT?: string;
  PORT?: string;
  OPENCLAW_BASE_URL?: string;
  AGENT_RELAY_SESSION?: AgentRelaySessionNamespace;
  PROXY_TRUST_STATE?: ProxyTrustStateNamespace;
  REGISTRY_URL?: string;
  CLAWDENTITY_REGISTRY_URL?: string;
  BOOTSTRAP_INTERNAL_SERVICE_ID?: string;
  BOOTSTRAP_INTERNAL_SERVICE_SECRET?: string;
  REGISTRY_INTERNAL_SERVICE_ID?: string;
  REGISTRY_INTERNAL_SERVICE_SECRET?: string;
  ENVIRONMENT?: string;
  ALLOW_ALL_VERIFIED?: string;
  CRL_REFRESH_INTERVAL_MS?: string;
  CRL_MAX_AGE_MS?: string;
  CRL_STALE_BEHAVIOR?: string;
  AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE?: string;
  AGENT_RATE_LIMIT_WINDOW_MS?: string;
  INJECT_IDENTITY_INTO_MESSAGE?: string;
  RELAY_QUEUE_MAX_MESSAGES_PER_AGENT?: string;
  RELAY_QUEUE_TTL_SECONDS?: string;
  RELAY_RETRY_INITIAL_MS?: string;
  RELAY_RETRY_MAX_MS?: string;
  RELAY_RETRY_MAX_ATTEMPTS?: string;
  RELAY_RETRY_JITTER_RATIO?: string;
  RELAY_MAX_IN_FLIGHT_DELIVERIES?: string;
  RELAY_MAX_FRAME_BYTES?: string;
  APP_VERSION?: string;
  PROXY_VERSION?: string;
  RECEIPT_QUEUE?: Queue<string>;
  [key: string]: unknown;
};

type CachedProxyRuntime = {
  key: string;
  app: ProxyApp;
  config: ProxyConfig;
};

type QueueEventEnvelope = {
  type: string;
  payload: Record<string, unknown>;
};

const logger = createLogger({ service: "proxy" });
let cachedRuntime: CachedProxyRuntime | undefined;

class NonRetryableQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableQueueError";
  }
}

function toCacheKey(env: ProxyWorkerBindings): string {
  const keyParts = [
    env.OPENCLAW_BASE_URL,
    env.PROXY_TRUST_STATE === undefined ? "no-trust-do" : "has-trust-do",
    env.REGISTRY_URL,
    env.CLAWDENTITY_REGISTRY_URL,
    env.BOOTSTRAP_INTERNAL_SERVICE_ID,
    env.BOOTSTRAP_INTERNAL_SERVICE_SECRET,
    env.REGISTRY_INTERNAL_SERVICE_ID,
    env.REGISTRY_INTERNAL_SERVICE_SECRET,
    env.ENVIRONMENT,
    env.ALLOW_ALL_VERIFIED,
    env.CRL_REFRESH_INTERVAL_MS,
    env.CRL_MAX_AGE_MS,
    env.CRL_STALE_BEHAVIOR,
    env.AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE,
    env.AGENT_RATE_LIMIT_WINDOW_MS,
    env.INJECT_IDENTITY_INTO_MESSAGE,
    env.RELAY_QUEUE_MAX_MESSAGES_PER_AGENT,
    env.RELAY_QUEUE_TTL_SECONDS,
    env.RELAY_RETRY_INITIAL_MS,
    env.RELAY_RETRY_MAX_MS,
    env.RELAY_RETRY_MAX_ATTEMPTS,
    env.RELAY_RETRY_JITTER_RATIO,
    env.RELAY_MAX_IN_FLIGHT_DELIVERIES,
    env.RELAY_MAX_FRAME_BYTES,
    env.APP_VERSION,
    env.PROXY_VERSION,
  ];

  return keyParts.map((value) => String(value ?? "")).join("|");
}

function buildRuntime(env: ProxyWorkerBindings): CachedProxyRuntime {
  const key = toCacheKey(env);
  if (cachedRuntime && cachedRuntime.key === key) {
    return cachedRuntime;
  }

  const config = parseProxyConfig(env, {
    requireRuntimeKeys: true,
  });
  const runtimeLogger = createLogger(
    { service: "proxy" },
    {
      minLevel: config.environment === "production" ? "warn" : "debug",
    },
  );
  const trustStoreResolution = resolveWorkerTrustStore({
    environment: config.environment,
    trustStateNamespace: env.PROXY_TRUST_STATE,
  });
  if (trustStoreResolution.backend === "memory") {
    runtimeLogger.warn("proxy.trust_store.memory_fallback", {
      environment: config.environment,
      reason: "PROXY_TRUST_STATE binding is unavailable",
    });
  }
  const app = createProxyApp({
    config,
    logger: runtimeLogger,
    trustStore: trustStoreResolution.trustStore,
    version: resolveProxyVersion(env),
    versionSource: resolveProxyVersionSource(env),
  });

  cachedRuntime = {
    key,
    app,
    config,
  };
  return cachedRuntime;
}

function toConfigErrorResponse(error: ProxyConfigError): Response {
  logger.error(error.message, {
    code: error.code,
    details: error.details,
  });

  return Response.json(
    {
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    },
    { status: error.status },
  );
}

function parseQueueEventEnvelope(messageBody: unknown): QueueEventEnvelope {
  if (typeof messageBody !== "string") {
    throw new NonRetryableQueueError("Queue message body must be a string");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(messageBody);
  } catch {
    throw new NonRetryableQueueError("Queue message body must be valid JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new NonRetryableQueueError(
      "Queue message body must be a JSON object",
    );
  }

  const eventType = (parsed as { type?: unknown }).type;
  if (typeof eventType !== "string" || eventType.trim().length === 0) {
    throw new NonRetryableQueueError(
      "Queue message body must include a non-empty type",
    );
  }

  return {
    type: eventType.trim(),
    payload: parsed as Record<string, unknown>,
  };
}

function parseDeliveryReceiptEvent(payload: unknown) {
  try {
    return parseReceiptQueueEvent(payload);
  } catch (error) {
    throw new NonRetryableQueueError(
      error instanceof Error
        ? error.message
        : "Invalid delivery receipt queue event payload",
    );
  }
}

function shouldRetryQueueError(error: unknown): boolean {
  if (error instanceof NonRetryableQueueError) {
    return false;
  }

  if (error instanceof RelaySessionDeliveryError) {
    return error.status === 429 || error.status >= 500;
  }

  if (error instanceof TypeError) {
    return true;
  }

  return true;
}

const worker = {
  fetch(
    request: Request,
    env: ProxyWorkerBindings,
    executionCtx: ExecutionContext,
  ): Response | Promise<Response> {
    try {
      const runtime = buildRuntime(env);
      return runtime.app.fetch(request, env, executionCtx);
    } catch (error) {
      if (error instanceof ProxyConfigError) {
        return toConfigErrorResponse(error);
      }

      logger.error("Unhandled proxy worker startup error", {
        errorName: error instanceof Error ? error.name : "unknown",
      });
      return Response.json(
        {
          error: {
            code: "PROXY_WORKER_STARTUP_FAILED",
            message: "Proxy worker startup failed",
          },
        },
        { status: 500 },
      );
    }
  },
  async queue(
    batch: MessageBatch<string>,
    env: ProxyWorkerBindings,
  ): Promise<void> {
    for (const message of batch.messages) {
      try {
        const event = parseQueueEventEnvelope(message.body);
        if (event.type !== DELIVERY_RECEIPT_EVENT_TYPE) {
          logger.warn("proxy.queue.message_ignored", {
            reason: "unsupported_event_type",
            eventType: event.type,
          });
          message.ack();
          continue;
        }

        const relaySessionNamespace = env.AGENT_RELAY_SESSION;
        if (relaySessionNamespace === undefined) {
          throw new NonRetryableQueueError(
            "Relay session namespace is unavailable",
          );
        }

        const parsedReceiptEvent = parseDeliveryReceiptEvent(event.payload);
        await handleReceiptQueueEvent({
          event: parsedReceiptEvent,
          relaySessionNamespace,
        });

        message.ack();
      } catch (error) {
        const shouldRetry = shouldRetryQueueError(error);
        logger.warn("proxy.queue.message_failed", {
          reason: error instanceof Error ? error.message : String(error),
          action: shouldRetry ? "retry" : "ack",
        });
        if (shouldRetry) {
          message.retry();
        } else {
          message.ack();
        }
      }
    }
  },
};

// biome-ignore lint/style/noDefaultExport: Cloudflare module workers require a default export entrypoint.
export default worker;
export { worker };
export { AgentRelaySession, ProxyTrustState };
