import { createLogger } from "@clawdentity/sdk";
import {
  AgentRelaySession,
  type AgentRelaySessionNamespace,
} from "./agent-relay-session.js";
import { DEFAULT_MAX_TIMESTAMP_SKEW_SECONDS } from "./auth-middleware.js";
import {
  type ProxyConfig,
  ProxyConfigError,
  parseProxyConfig,
} from "./config.js";
import { resolveProxyVersion, resolveProxyVersionSource } from "./index.js";
import { resolveWorkerNonceReplayStore } from "./nonce-replay-backend.js";
import { NonceReplayGuard } from "./nonce-replay-guard.js";
import type { NonceReplayGuardNamespace } from "./nonce-replay-store.js";
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
  NONCE_REPLAY_GUARD?: NonceReplayGuardNamespace;
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

const logger = createLogger({ service: "proxy" });
let cachedRuntime: CachedProxyRuntime | undefined;

function toCacheKey(env: ProxyWorkerBindings): string {
  const keyParts = [
    env.OPENCLAW_BASE_URL,
    env.PROXY_TRUST_STATE === undefined ? "no-trust-do" : "has-trust-do",
    env.NONCE_REPLAY_GUARD === undefined ? "no-nonce-do" : "has-nonce-do",
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
  const nonceReplayResolution = resolveWorkerNonceReplayStore({
    environment: config.environment,
    nonceReplayNamespace: env.NONCE_REPLAY_GUARD,
    maxTimestampSkewSeconds: DEFAULT_MAX_TIMESTAMP_SKEW_SECONDS,
  });
  if (trustStoreResolution.backend === "memory") {
    runtimeLogger.warn("proxy.trust_store.memory_fallback", {
      environment: config.environment,
      reason: "PROXY_TRUST_STATE binding is unavailable",
    });
  }
  if (nonceReplayResolution.backend === "memory") {
    runtimeLogger.warn("proxy.nonce_replay.memory_fallback", {
      environment: config.environment,
      reason: "NONCE_REPLAY_GUARD binding is unavailable",
    });
  }
  const app = createProxyApp({
    config,
    logger: runtimeLogger,
    trustStore: trustStoreResolution.trustStore,
    auth: {
      nonceCache: nonceReplayResolution.nonceCache,
      maxTimestampSkewSeconds: DEFAULT_MAX_TIMESTAMP_SKEW_SECONDS,
    },
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
        const parsed =
          typeof message.body === "string" ? JSON.parse(message.body) : null;
        if (typeof parsed !== "object" || parsed === null) {
          throw new Error("Queue message body must be a JSON object");
        }

        const eventType = (parsed as { type?: unknown }).type;
        if (eventType !== DELIVERY_RECEIPT_EVENT_TYPE) {
          throw new Error("Unsupported queue event type");
        }

        const relaySessionNamespace = env.AGENT_RELAY_SESSION;
        if (relaySessionNamespace === undefined) {
          throw new Error("Relay session namespace is unavailable");
        }

        const event = parseReceiptQueueEvent(parsed);
        await handleReceiptQueueEvent({
          event,
          relaySessionNamespace,
        });

        message.ack();
      } catch (error) {
        logger.warn("proxy.queue.message_failed", {
          reason: error instanceof Error ? error.message : String(error),
        });
        message.retry();
      }
    }
  },
};

// biome-ignore lint/style/noDefaultExport: Cloudflare module workers require a default export fetch entrypoint.
export default worker;
export { worker };
export { AgentRelaySession, NonceReplayGuard, ProxyTrustState };
