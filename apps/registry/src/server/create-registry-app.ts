import {
  createHonoErrorHandler,
  createRequestContextMiddleware,
  createRequestLoggingMiddleware,
  type EventBus,
  parseRegistryConfig,
  type RegistryConfig,
} from "@clawdentity/sdk";
import { Hono } from "hono";
import type { AuthenticatedHuman } from "../auth/api-key-auth.js";
import type { AuthenticatedService } from "../auth/service-auth.js";
import {
  AGENT_AUTH_REFRESH_RATE_LIMIT_MAX_REQUESTS,
  AGENT_AUTH_REFRESH_RATE_LIMIT_WINDOW_MS,
  AGENT_AUTH_VALIDATE_RATE_LIMIT_MAX_REQUESTS,
  AGENT_AUTH_VALIDATE_RATE_LIMIT_WINDOW_MS,
  CRL_RATE_LIMIT_MAX_REQUESTS,
  CRL_RATE_LIMIT_WINDOW_MS,
  createInMemoryRateLimit,
  RESOLVE_RATE_LIMIT_MAX_REQUESTS,
  RESOLVE_RATE_LIMIT_WINDOW_MS,
} from "../rate-limit.js";
import {
  type Bindings,
  type CreateRegistryAppOptions,
  logger,
  type RegistryApp,
} from "./constants.js";
import {
  resolveEventBusBackend,
  resolveRegistryEventBus,
} from "./helpers/event-bus.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAgentAuthRoutes } from "./routes/agent-auth.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerInternalServiceRoutes } from "./routes/internal-services.js";
import { registerInviteRoutes } from "./routes/invites.js";
import { registerMeApiKeyRoutes } from "./routes/me-api-keys.js";

export function createRegistryApp(options: CreateRegistryAppOptions = {}) {
  let cachedConfig: RegistryConfig | undefined;
  let cachedEventBus: EventBus | undefined;
  let cachedEventBusKey: string | undefined;

  function getConfig(bindings: Bindings): RegistryConfig {
    if (cachedConfig) {
      return cachedConfig;
    }

    cachedConfig = parseRegistryConfig(bindings, {
      requireRuntimeKeys: true,
    });
    return cachedConfig;
  }

  function getEventBus(bindings: Bindings): EventBus {
    if (options.eventBus !== undefined) {
      return options.eventBus;
    }

    const config = getConfig(bindings);
    const resolvedBackend = resolveEventBusBackend(config);
    const key = `${config.ENVIRONMENT}|${resolvedBackend}|${
      bindings.EVENT_BUS_QUEUE === undefined ? "no-queue" : "has-queue"
    }`;
    if (cachedEventBus && cachedEventBusKey === key) {
      return cachedEventBus;
    }

    const resolved = resolveRegistryEventBus({
      config,
      bindings,
      explicitBus: options.eventBus,
    });
    cachedEventBus = resolved;
    cachedEventBusKey = key;
    return resolved;
  }

  const app: RegistryApp = new Hono<{
    Bindings: Bindings;
    Variables: {
      requestId: string;
      human: AuthenticatedHuman;
      service: AuthenticatedService;
    };
  }>();

  const rateLimitOptions = options.rateLimit;
  const resolveRateLimit = createInMemoryRateLimit({
    bucketKey: "resolve",
    maxRequests:
      rateLimitOptions?.resolveMaxRequests ?? RESOLVE_RATE_LIMIT_MAX_REQUESTS,
    windowMs: rateLimitOptions?.resolveWindowMs ?? RESOLVE_RATE_LIMIT_WINDOW_MS,
    nowMs: rateLimitOptions?.nowMs,
  });
  const crlRateLimit = createInMemoryRateLimit({
    bucketKey: "crl",
    maxRequests:
      rateLimitOptions?.crlMaxRequests ?? CRL_RATE_LIMIT_MAX_REQUESTS,
    windowMs: rateLimitOptions?.crlWindowMs ?? CRL_RATE_LIMIT_WINDOW_MS,
    nowMs: rateLimitOptions?.nowMs,
  });
  const agentAuthRefreshRateLimit = createInMemoryRateLimit({
    bucketKey: "agent_auth_refresh",
    maxRequests:
      rateLimitOptions?.agentAuthRefreshMaxRequests ??
      AGENT_AUTH_REFRESH_RATE_LIMIT_MAX_REQUESTS,
    windowMs:
      rateLimitOptions?.agentAuthRefreshWindowMs ??
      AGENT_AUTH_REFRESH_RATE_LIMIT_WINDOW_MS,
    nowMs: rateLimitOptions?.nowMs,
  });
  const agentAuthValidateRateLimit = createInMemoryRateLimit({
    bucketKey: "agent_auth_validate",
    maxRequests:
      rateLimitOptions?.agentAuthValidateMaxRequests ??
      AGENT_AUTH_VALIDATE_RATE_LIMIT_MAX_REQUESTS,
    windowMs:
      rateLimitOptions?.agentAuthValidateWindowMs ??
      AGENT_AUTH_VALIDATE_RATE_LIMIT_WINDOW_MS,
    nowMs: rateLimitOptions?.nowMs,
  });

  app.use("*", createRequestContextMiddleware());
  app.use("*", createRequestLoggingMiddleware(logger));
  app.onError(createHonoErrorHandler(logger));

  registerHealthRoutes({
    app,
    getConfig,
    getEventBus,
    resolveRateLimit,
    crlRateLimit,
  });
  registerAdminRoutes({
    app,
    getConfig,
    getEventBus,
  });
  registerInternalServiceRoutes({
    app,
    getConfig,
    getEventBus,
  });
  registerInviteRoutes({
    app,
    getConfig,
    getEventBus,
  });
  registerMeApiKeyRoutes({
    app,
    getConfig,
    getEventBus,
  });
  registerAgentRoutes({
    app,
    getConfig,
    getEventBus,
  });
  registerAgentAuthRoutes({
    app,
    getConfig,
    getEventBus,
    agentAuthRefreshRateLimit,
    agentAuthValidateRateLimit,
  });

  return app;
}
