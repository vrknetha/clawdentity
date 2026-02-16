import { createLogger, type Logger } from "@clawdentity/sdk";
import { type ServerType, serve } from "@hono/node-server";
import type { ProxyConfig } from "./config.js";
import { loadProxyConfig } from "./config.js";
import { PROXY_VERSION } from "./index.js";
import { createProxyApp, type ProxyApp } from "./server.js";

type StartProxyServerOptions = {
  env?: unknown;
  config?: ProxyConfig;
  logger?: Logger;
  port?: number;
};

export type StartedProxyServer = {
  app: ProxyApp;
  config: ProxyConfig;
  port: number;
  server: ServerType;
};

function resolveLogger(logger?: Logger): Logger {
  return logger ?? createLogger({ service: "proxy" });
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
