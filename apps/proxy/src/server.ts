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
import { PAIR_CONFIRM_PATH, PAIR_START_PATH } from "./pairing-constants.js";
import {
  createPairConfirmHandler,
  createPairStartHandler,
  type PairConfirmRuntimeOptions,
  type PairStartRuntimeOptions,
} from "./pairing-route.js";
import {
  createInMemoryProxyTrustStore,
  type ProxyTrustStore,
} from "./proxy-trust-store.js";
import {
  createPublicRateLimitMiddleware,
  DEFAULT_PRE_AUTH_IP_RATE_LIMIT_REQUESTS_PER_MINUTE,
  DEFAULT_PRE_AUTH_IP_RATE_LIMIT_WINDOW_MS,
} from "./public-rate-limit-middleware.js";
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
  publicIpMaxRequests?: number;
  publicIpWindowMs?: number;
};

type CreateProxyAppOptions = {
  config: ProxyConfig;
  version?: string;
  logger?: Logger;
  registerRoutes?: (app: ProxyApp) => void;
  auth?: ProxyAuthRuntimeOptions;
  rateLimit?: ProxyRateLimitRuntimeOptions;
  hooks?: AgentHookRuntimeOptions;
  relay?: RelayConnectRuntimeOptions;
  pairing?: {
    confirm?: PairConfirmRuntimeOptions;
    start?: PairStartRuntimeOptions;
  };
  trustStore?: ProxyTrustStore;
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
  const trustStore = options.trustStore ?? createInMemoryProxyTrustStore();
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
    createPublicRateLimitMiddleware({
      logger,
      paths: ["/hooks/agent", RELAY_CONNECT_PATH],
      maxRequests:
        options.rateLimit?.publicIpMaxRequests ??
        DEFAULT_PRE_AUTH_IP_RATE_LIMIT_REQUESTS_PER_MINUTE,
      windowMs:
        options.rateLimit?.publicIpWindowMs ??
        DEFAULT_PRE_AUTH_IP_RATE_LIMIT_WINDOW_MS,
      nowMs: options.rateLimit?.nowMs,
    }),
  );
  app.use(
    "*",
    createProxyAuthMiddleware({
      config: options.config,
      logger,
      trustStore,
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
      version: options.version ?? PROXY_VERSION,
      environment: options.config.environment,
    }),
  );
  app.post(
    "/hooks/agent",
    createAgentHookHandler({
      logger,
      injectIdentityIntoMessage: options.config.injectIdentityIntoMessage,
      trustStore,
      ...options.hooks,
    }),
  );
  app.post(
    PAIR_START_PATH,
    createPairStartHandler({
      logger,
      registryUrl: options.config.registryUrl,
      issuerProxyUrl: options.config.pairingIssuerUrl,
      trustStore,
      ...options.pairing?.start,
    }),
  );
  app.post(
    PAIR_CONFIRM_PATH,
    createPairConfirmHandler({
      logger,
      registryUrl: options.config.registryUrl,
      trustStore,
      ...options.pairing?.confirm,
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
