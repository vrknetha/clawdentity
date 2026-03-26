import { RELAY_CONNECT_PATH } from "@clawdentity/protocol";
import {
  type CrlCache,
  createHonoErrorHandler,
  createLogger,
  createRequestContextMiddleware,
  createRequestLoggingMiddleware,
  type Logger,
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
  type ProxyNonceCache,
  type ProxyRequestVariables,
} from "./auth-middleware.js";
import type { ProxyConfig } from "./config.js";
import { PROXY_VERSION, type ProxyVersionSource } from "./index.js";
import type { NonceReplayGuardNamespace } from "./nonce-replay-store.js";
import {
  PAIR_CONFIRM_PATH,
  PAIR_START_PATH,
  PAIR_STATUS_PATH,
} from "./pairing-constants.js";
import {
  createPairConfirmHandler,
  createPairStartHandler,
  createPairStatusHandler,
  type PairConfirmRuntimeOptions,
  type PairStartRuntimeOptions,
  type PairStatusRuntimeOptions,
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
import {
  createRelayDeliveryReceiptGetHandler,
  createRelayDeliveryReceiptPostHandler,
  RELAY_DELIVERY_RECEIPTS_PATH,
} from "./relay-delivery-receipt-route.js";

type ProxyAuthRuntimeOptions = {
  fetchImpl?: typeof fetch;
  clock?: () => number;
  nonceCache?: ProxyNonceCache;
  crlCache?: CrlCache;
  maxTimestampSkewSeconds?: number;
};

type ProxyRateLimitRuntimeOptions = {
  nowMs?: () => number;
  publicIpMaxRequests?: number;
  publicIpWindowMs?: number;
};

type CreateProxyAppOptions = {
  config: ProxyConfig;
  version?: string;
  versionSource?: ProxyVersionSource;
  logger?: Logger;
  registerRoutes?: (app: ProxyApp) => void;
  auth?: ProxyAuthRuntimeOptions;
  rateLimit?: ProxyRateLimitRuntimeOptions;
  hooks?: AgentHookRuntimeOptions;
  relay?: RelayConnectRuntimeOptions;
  pairing?: {
    confirm?: PairConfirmRuntimeOptions;
    status?: PairStatusRuntimeOptions;
    start?: PairStartRuntimeOptions;
  };
  trustStore?: ProxyTrustStore;
};

export type ProxyApp = Hono<{
  Bindings: {
    AGENT_RELAY_SESSION?: AgentRelaySessionNamespace;
    PROXY_TRUST_STATE?: object;
    NONCE_REPLAY_GUARD?: NonceReplayGuardNamespace;
  };
  Variables: ProxyRequestVariables;
}>;

function resolveLogger(config: ProxyConfig, logger?: Logger): Logger {
  if (logger) {
    return logger;
  }

  return createLogger(
    { service: "proxy" },
    {
      minLevel: config.environment === "production" ? "warn" : "debug",
    },
  );
}

function resolveRequestLoggingOptions(config: ProxyConfig) {
  return config.environment === "production"
    ? {
        onlyErrors: true,
        slowThresholdMs: 3_000,
        errorOrSlowLogLevel: "warn" as const,
      }
    : {};
}

function buildHealthPayload(input: {
  config: ProxyConfig;
  version: string;
  versionSource: ProxyVersionSource;
  bindings: {
    AGENT_RELAY_SESSION?: AgentRelaySessionNamespace;
    PROXY_TRUST_STATE?: object;
    NONCE_REPLAY_GUARD?: NonceReplayGuardNamespace;
  };
}) {
  const requiresDurableTrustState = input.config.environment !== "local";
  const requiresDurableNonceReplay = input.config.environment !== "local";
  const readiness = {
    versionSource: input.versionSource,
    registryUrlConfigured: input.config.registryUrl.length > 0,
    internalServiceCredentialsConfigured:
      typeof input.config.registryInternalServiceId === "string" &&
      typeof input.config.registryInternalServiceSecret === "string",
    relaySessionNamespaceConfigured:
      input.bindings.AGENT_RELAY_SESSION !== undefined,
    trustStateBindingConfigured:
      input.bindings.PROXY_TRUST_STATE !== undefined ||
      !requiresDurableTrustState,
    nonceReplayBindingConfigured:
      input.bindings.NONCE_REPLAY_GUARD !== undefined ||
      !requiresDurableNonceReplay,
    openclawBaseUrlConfigured: input.config.openclawBaseUrl.length > 0,
  };

  return {
    status: "ok",
    ready: Object.entries(readiness).every(([, value]) =>
      typeof value === "boolean" ? value : true,
    ),
    version: input.version,
    environment: input.config.environment,
    readiness,
  };
}

export function createProxyApp(options: CreateProxyAppOptions): ProxyApp {
  const logger = resolveLogger(options.config, options.logger);
  const trustStore = options.trustStore ?? createInMemoryProxyTrustStore();
  const app = new Hono<{
    Bindings: {
      AGENT_RELAY_SESSION?: AgentRelaySessionNamespace;
      PROXY_TRUST_STATE?: object;
      NONCE_REPLAY_GUARD?: NonceReplayGuardNamespace;
    };
    Variables: ProxyRequestVariables;
  }>();

  app.use("*", createRequestContextMiddleware());
  app.use(
    "*",
    createRequestLoggingMiddleware(
      logger,
      resolveRequestLoggingOptions(options.config),
    ),
  );
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

  app.get("/health", (c) => {
    const bindings = (c.env ?? {}) as {
      AGENT_RELAY_SESSION?: AgentRelaySessionNamespace;
      PROXY_TRUST_STATE?: object;
      NONCE_REPLAY_GUARD?: NonceReplayGuardNamespace;
    };

    return c.json(
      buildHealthPayload({
        config: options.config,
        version: options.version ?? PROXY_VERSION,
        versionSource: options.versionSource ?? "default",
        bindings: {
          AGENT_RELAY_SESSION: bindings.AGENT_RELAY_SESSION,
          PROXY_TRUST_STATE: bindings.PROXY_TRUST_STATE,
          NONCE_REPLAY_GUARD: bindings.NONCE_REPLAY_GUARD,
        },
      }),
    );
  });
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
      registryInternalServiceId: options.config.registryInternalServiceId,
      registryInternalServiceSecret:
        options.config.registryInternalServiceSecret,
      trustStore,
      ...options.pairing?.start,
    }),
  );
  app.post(
    PAIR_CONFIRM_PATH,
    createPairConfirmHandler({
      logger,
      trustStore,
      ...options.pairing?.confirm,
    }),
  );
  app.post(
    PAIR_STATUS_PATH,
    createPairStatusHandler({
      logger,
      trustStore,
      ...options.pairing?.status,
    }),
  );
  app.get(
    RELAY_CONNECT_PATH,
    createRelayConnectHandler({
      logger,
      ...options.relay,
    }),
  );
  app.post(
    RELAY_DELIVERY_RECEIPTS_PATH,
    createRelayDeliveryReceiptPostHandler({
      logger,
      trustStore,
    }),
  );
  app.get(
    RELAY_DELIVERY_RECEIPTS_PATH,
    createRelayDeliveryReceiptGetHandler({
      logger,
      trustStore,
    }),
  );
  options.registerRoutes?.(app);

  return app;
}
