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
import { ProxyTrustStoreError } from "./proxy-trust-store.js";
import {
  GROUP_MEMBER_JOINED_EVENT_TYPE,
  handleGroupMemberJoinedQueueEvent,
  parseGroupMemberJoinedQueueEvent,
} from "./queue-consumer/group-member-joined-events.js";
import {
  handlePairAcceptedQueueEvent,
  PAIR_ACCEPTED_EVENT_TYPE,
  parsePairAcceptedQueueEvent,
} from "./queue-consumer/pairing-events.js";
import {
  DELIVERY_RECEIPT_EVENT_TYPE,
  handleReceiptQueueEvent,
  parseReceiptQueueEvent,
} from "./queue-consumer/receipt-events.js";
import {
  AGENT_AUTH_REVOKED_EVENT_TYPE,
  handleRegistryRevocationEvent,
  parseRegistryRevocationEvent,
} from "./queue-consumer/registry-events.js";
import { createProxyApp, type ProxyApp } from "./server.js";
import { resolveWorkerTrustStore } from "./trust-store-backend.js";

export type ProxyWorkerBindings = {
  LISTEN_PORT?: string;
  PORT?: string;
  DELIVERY_WEBHOOK_BASE_URL?: string;
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
  DELIVERY_STATE_DIR?: string;
  APP_VERSION?: string;
  PROXY_VERSION?: string;
  RECEIPT_QUEUE?: Queue<string>;
  EVENTS_QUEUE?: Queue<string>;
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

class MissingQueueBindingError extends NonRetryableQueueError {
  constructor(bindingName: string, eventType: string) {
    super(
      `Queue binding '${bindingName}' is unavailable for event type '${eventType}'`,
    );
    this.name = "MissingQueueBindingError";
  }
}

function toCacheKey(env: ProxyWorkerBindings): string {
  const keyParts = [
    env.DELIVERY_WEBHOOK_BASE_URL,
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

function parseRegistryRevocationQueueEvent(payload: unknown) {
  try {
    return parseRegistryRevocationEvent(payload);
  } catch (error) {
    throw new NonRetryableQueueError(
      error instanceof Error
        ? error.message
        : "Invalid registry revocation queue event payload",
    );
  }
}

function parsePairAcceptedEvent(payload: unknown) {
  try {
    return parsePairAcceptedQueueEvent(payload);
  } catch (error) {
    throw new NonRetryableQueueError(
      error instanceof Error
        ? error.message
        : "Invalid pair accepted queue event payload",
    );
  }
}

function parseGroupMemberJoinedEvent(payload: unknown) {
  try {
    return parseGroupMemberJoinedQueueEvent(payload);
  } catch (error) {
    throw new NonRetryableQueueError(
      error instanceof Error
        ? error.message
        : "Invalid group member joined queue event payload",
    );
  }
}

type QueueFailureAction = "ack" | "retry";

function resolveQueueFailureAction(error: unknown): {
  action: QueueFailureAction;
  reasonCode: string;
} {
  if (error instanceof NonRetryableQueueError) {
    if (error instanceof MissingQueueBindingError) {
      return { action: "ack", reasonCode: "missing_queue_binding" };
    }

    return { action: "ack", reasonCode: "non_retryable_queue_error" };
  }

  if (error instanceof RelaySessionDeliveryError) {
    if (error.status === 429 || error.status >= 500) {
      return {
        action: "retry",
        reasonCode: "relay_session_transient_error",
      };
    }

    return {
      action: "ack",
      reasonCode: "relay_session_non_retryable_error",
    };
  }

  if (error instanceof TypeError) {
    return { action: "retry", reasonCode: "transport_type_error" };
  }

  if (error instanceof ProxyTrustStoreError) {
    if (error.status >= 500) {
      return { action: "retry", reasonCode: "trust_state_transient_error" };
    }

    return { action: "ack", reasonCode: "trust_state_non_retryable_error" };
  }

  return { action: "retry", reasonCode: "unknown_retryable_error" };
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
        if (event.type === PAIR_ACCEPTED_EVENT_TYPE) {
          const relaySessionNamespace = env.AGENT_RELAY_SESSION;
          if (relaySessionNamespace === undefined) {
            throw new MissingQueueBindingError(
              "AGENT_RELAY_SESSION",
              event.type,
            );
          }

          const parsedPairAcceptedEvent = parsePairAcceptedEvent(event.payload);
          await handlePairAcceptedQueueEvent({
            event: parsedPairAcceptedEvent,
            relaySessionNamespace,
          });

          message.ack();
          continue;
        }

        if (event.type === GROUP_MEMBER_JOINED_EVENT_TYPE) {
          const relaySessionNamespace = env.AGENT_RELAY_SESSION;
          if (relaySessionNamespace === undefined) {
            throw new MissingQueueBindingError(
              "AGENT_RELAY_SESSION",
              event.type,
            );
          }

          const parsedGroupMemberJoinedEvent = parseGroupMemberJoinedEvent(
            event.payload,
          );
          await handleGroupMemberJoinedQueueEvent({
            event: parsedGroupMemberJoinedEvent,
            relaySessionNamespace,
          });

          message.ack();
          continue;
        }

        if (event.type === DELIVERY_RECEIPT_EVENT_TYPE) {
          const relaySessionNamespace = env.AGENT_RELAY_SESSION;
          if (relaySessionNamespace === undefined) {
            throw new MissingQueueBindingError(
              "AGENT_RELAY_SESSION",
              event.type,
            );
          }

          const parsedReceiptEvent = parseDeliveryReceiptEvent(event.payload);
          await handleReceiptQueueEvent({
            event: parsedReceiptEvent,
            relaySessionNamespace,
          });

          message.ack();
          continue;
        }

        if (event.type === AGENT_AUTH_REVOKED_EVENT_TYPE) {
          const trustStateNamespace = env.PROXY_TRUST_STATE;
          if (trustStateNamespace === undefined) {
            throw new MissingQueueBindingError("PROXY_TRUST_STATE", event.type);
          }

          const parsedRevocationEvent = parseRegistryRevocationQueueEvent(
            event.payload,
          );
          if (parsedRevocationEvent === null) {
            logger.warn("proxy.queue.message_ignored", {
              reason: "unsupported_registry_revocation_reason",
              eventType: event.type,
            });
            message.ack();
            continue;
          }

          await handleRegistryRevocationEvent({
            agentDid: parsedRevocationEvent.agentDid,
            trustStateNamespace,
          });

          message.ack();
          continue;
        }

        logger.warn("proxy.queue.message_ignored", {
          reason: "unsupported_event_type",
          eventType: event.type,
        });
        message.ack();
      } catch (error) {
        const failureAction = resolveQueueFailureAction(error);
        logger.warn("proxy.queue.message_failed", {
          reason: error instanceof Error ? error.message : String(error),
          action: failureAction.action,
          reasonCode: failureAction.reasonCode,
          errorName: error instanceof Error ? error.name : "unknown",
          relayStatus:
            error instanceof RelaySessionDeliveryError ? error.status : null,
          relayCode:
            error instanceof RelaySessionDeliveryError ? error.code : null,
          trustStoreStatus:
            error instanceof ProxyTrustStoreError ? error.status : null,
          trustStoreCode:
            error instanceof ProxyTrustStoreError ? error.code : null,
        });
        if (failureAction.action === "retry") {
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
