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
import {
  createProxyAuthMiddleware,
  type ProxyRequestVariables,
} from "./auth-middleware.js";
import type { ProxyConfig } from "./config.js";
import { PROXY_VERSION } from "./index.js";

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
};

export type ProxyApp = Hono<{
  Variables: ProxyRequestVariables;
}>;

function resolveLogger(logger?: Logger): Logger {
  return logger ?? createLogger({ service: "proxy" });
}

export function createProxyApp(options: CreateProxyAppOptions): ProxyApp {
  const logger = resolveLogger(options.logger);
  const app = new Hono<{
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
      openclawBaseUrl: options.config.openclawBaseUrl,
      openclawHookToken: options.config.openclawHookToken,
      injectIdentityIntoMessage: options.config.injectIdentityIntoMessage,
      ...options.hooks,
    }),
  );
  options.registerRoutes?.(app);

  return app;
}
