import { RELAY_CONNECT_PATH } from "@clawdentity/protocol";
import {
  type CrlCache,
  createHonoErrorHandler,
  createLogger,
  createRequestContextMiddleware,
  createRequestLoggingMiddleware,
  type Logger,
  type NonceCache,
} from "@clawdentity/sdk";
import { Hono } from "hono";
import {
  type AgentHookRuntimeOptions,
  createAgentHookHandler,
} from "./agent-hook-route.js";
import { createAgentRateLimitMiddleware } from "./agent-rate-limit-middleware.js";
import type { AgentRelaySessionNamespace } from "./agent-relay-session.js";
import {
  createProxyAuthMiddleware,
  type ProxyRequestVariables,
} from "./auth-middleware.js";
import type { ProxyConfig } from "./config.js";
import { PROXY_VERSION } from "./index.js";
import {
  createRelayConnectHandler,
  type RelayConnectRuntimeOptions,
} from "./relay-connect-route.js";

type ProxyAuthRuntimeOptions = {
  fetchImpl?: typeof fetch;
  clock?: () => number;
  nonceCache?: NonceCache;
  crlCache?: CrlCache;
};

type ProxyRateLimitRuntimeOptions = {
  nowMs?: () => number;
};

type CreateProxyAppOptions = {
  config: ProxyConfig;
  logger?: Logger;
  registerRoutes?: (app: ProxyApp) => void;
  auth?: ProxyAuthRuntimeOptions;
  rateLimit?: ProxyRateLimitRuntimeOptions;
  hooks?: AgentHookRuntimeOptions;
  relay?: RelayConnectRuntimeOptions;
};

export type ProxyApp = Hono<{
  Bindings: {
    AGENT_RELAY_SESSION?: AgentRelaySessionNamespace;
  };
  Variables: ProxyRequestVariables;
}>;

function resolveLogger(logger?: Logger): Logger {
  return logger ?? createLogger({ service: "proxy" });
}

export function createProxyApp(options: CreateProxyAppOptions): ProxyApp {
  const logger = resolveLogger(options.logger);
  const app = new Hono<{
    Bindings: {
      AGENT_RELAY_SESSION?: AgentRelaySessionNamespace;
    };
    Variables: ProxyRequestVariables;
  }>();

  app.use("*", createRequestContextMiddleware());
  app.use("*", createRequestLoggingMiddleware(logger));
  app.use(
    "*",
    createProxyAuthMiddleware({
      config: options.config,
      logger,
      ...options.auth,
    }),
  );
  app.use(
    "*",
    createAgentRateLimitMiddleware({
      config: options.config,
      logger,
      ...options.rateLimit,
    }),
  );
  app.onError(createHonoErrorHandler(logger));

  app.get("/health", (c) =>
    c.json({
      status: "ok",
      version: PROXY_VERSION,
      environment: options.config.environment,
    }),
  );
  app.post(
    "/hooks/agent",
    createAgentHookHandler({
      logger,
      injectIdentityIntoMessage: options.config.injectIdentityIntoMessage,
      ...options.hooks,
    }),
  );
  app.get(
    RELAY_CONNECT_PATH,
    createRelayConnectHandler({
      logger,
      ...options.relay,
    }),
  );
  options.registerRoutes?.(app);

  return app;
}
