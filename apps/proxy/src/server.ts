import {
  type CrlCache,
  createHonoErrorHandler,
  createLogger,
  createRequestContextMiddleware,
  createRequestLoggingMiddleware,
  type Logger,
  type NonceCache,
} from "@clawdentity/sdk";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import {
  createProxyAuthMiddleware,
  type ProxyRequestVariables,
} from "./auth-middleware.js";
import type { ProxyConfig } from "./config.js";
import { loadProxyConfig } from "./config.js";
import { PROXY_VERSION } from "./index.js";

type ProxyAuthRuntimeOptions = {
  fetchImpl?: typeof fetch;
  clock?: () => number;
  nonceCache?: NonceCache;
  crlCache?: CrlCache;
};

type CreateProxyAppOptions = {
  config: ProxyConfig;
  logger?: Logger;
  registerRoutes?: (app: ProxyApp) => void;
  auth?: ProxyAuthRuntimeOptions;
};

type StartProxyServerOptions = {
  env?: unknown;
  config?: ProxyConfig;
  logger?: Logger;
  port?: number;
};

export type ProxyApp = Hono<{
  Variables: ProxyRequestVariables;
}>;

export type StartedProxyServer = {
  app: ProxyApp;
  config: ProxyConfig;
  port: number;
  server: ReturnType<typeof serve>;
};

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
  app.onError(createHonoErrorHandler(logger));

  app.get("/health", (c) =>
    c.json({
      status: "ok",
      version: PROXY_VERSION,
      environment: options.config.environment,
    }),
  );
  options.registerRoutes?.(app);

  return app;
}

export function startProxyServer(
  options: StartProxyServerOptions = {},
): StartedProxyServer {
  const config = options.config ?? loadProxyConfig(options.env);
  const logger = resolveLogger(options.logger);
  const app = createProxyApp({
    config,
    logger,
  });
  const port = options.port ?? config.listenPort;
  const server = serve({
    fetch: app.fetch,
    port,
  });

  logger.info("proxy.server_started", {
    port,
    version: PROXY_VERSION,
    environment: config.environment,
  });

  return {
    app,
    config,
    port,
    server,
  };
}
