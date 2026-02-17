import { createLogger } from "@clawdentity/sdk";
import {
  AgentRelaySession,
  type AgentRelaySessionNamespace,
} from "./agent-relay-session.js";
import {
  type ProxyConfig,
  ProxyConfigError,
  parseProxyConfig,
} from "./config.js";
import { resolveProxyVersion } from "./index.js";
import { ProxyTrustState } from "./proxy-trust-state.js";
import {
  createDurableProxyTrustStore,
  createInMemoryProxyTrustStore,
  type ProxyTrustStateNamespace,
} from "./proxy-trust-store.js";
import { createProxyApp, type ProxyApp } from "./server.js";

export type ProxyWorkerBindings = {
  LISTEN_PORT?: string;
  PORT?: string;
  OPENCLAW_BASE_URL?: string;
  AGENT_RELAY_SESSION?: AgentRelaySessionNamespace;
  PROXY_TRUST_STATE?: ProxyTrustStateNamespace;
  REGISTRY_URL?: string;
  CLAWDENTITY_REGISTRY_URL?: string;
  ENVIRONMENT?: string;
  ALLOW_ALL_VERIFIED?: string;
  CRL_REFRESH_INTERVAL_MS?: string;
  CRL_MAX_AGE_MS?: string;
  CRL_STALE_BEHAVIOR?: string;
  AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE?: string;
  AGENT_RATE_LIMIT_WINDOW_MS?: string;
  INJECT_IDENTITY_INTO_MESSAGE?: string;
  APP_VERSION?: string;
  PROXY_VERSION?: string;
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
    env.REGISTRY_URL,
    env.CLAWDENTITY_REGISTRY_URL,
    env.ENVIRONMENT,
    env.ALLOW_ALL_VERIFIED,
    env.CRL_REFRESH_INTERVAL_MS,
    env.CRL_MAX_AGE_MS,
    env.CRL_STALE_BEHAVIOR,
    env.AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE,
    env.AGENT_RATE_LIMIT_WINDOW_MS,
    env.INJECT_IDENTITY_INTO_MESSAGE,
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

  const config = parseProxyConfig(env);
  const app = createProxyApp({
    config,
    logger,
    trustStore:
      env.PROXY_TRUST_STATE !== undefined
        ? createDurableProxyTrustStore(env.PROXY_TRUST_STATE)
        : createInMemoryProxyTrustStore(),
    version: resolveProxyVersion(env),
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
};

export { AgentRelaySession, ProxyTrustState };
export default worker;
