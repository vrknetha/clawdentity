import { createLogger, type Logger } from "@clawdentity/sdk";
import { type ServerType, serve } from "@hono/node-server";
import type { ProxyConfig } from "./config.js";
import { loadProxyConfig } from "./config.js";
import { PROXY_VERSION } from "./index.js";
import { createProxyApp, type ProxyApp } from "./server.js";
import { resolveNodeTrustStore } from "./trust-store-backend.js";

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

function resolveDefaultNodeEnv(): unknown {
  const nodeProcess = (globalThis as { process?: { env?: unknown } }).process;
  const processEnv =
    typeof nodeProcess?.env === "object" && nodeProcess.env !== null
      ? (nodeProcess.env as Record<string, unknown>)
      : {};

  if (
    typeof processEnv.ENVIRONMENT === "string" &&
    processEnv.ENVIRONMENT.trim().length > 0
  ) {
    return processEnv;
  }

  return {
    ...processEnv,
    ENVIRONMENT: "local",
  };
}

export function startProxyServer(
  options: StartProxyServerOptions = {},
): StartedProxyServer {
  const config =
    options.config ??
    loadProxyConfig(options.env ?? resolveDefaultNodeEnv(), {
      requireRuntimeKeys: true,
    });
  const logger = resolveLogger(options.logger);
  const trustStoreResolution = resolveNodeTrustStore({
    environment: config.environment,
  });
  if (trustStoreResolution.backend === "memory") {
    logger.warn("proxy.trust_store.memory_fallback", {
      environment: config.environment,
      runtime: "node",
      reason: "Node runtime has no Durable Object trust binding",
    });
  }
  const app = createProxyApp({
    config,
    logger,
    trustStore: trustStoreResolution.trustStore,
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
    trustStoreBackend: trustStoreResolution.backend,
  });

  return {
    app,
    config,
    port,
    server,
  };
}
