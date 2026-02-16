import { createLogger } from "@clawdentity/sdk";
import {
  DEFAULT_OPENCLAW_BASE_URL,
  type ProxyConfig,
  ProxyConfigError,
  parseProxyConfig,
} from "./config.js";
import { createProxyApp, type ProxyApp } from "./server.js";

export type ProxyWorkerBindings = {
  LISTEN_PORT?: string;
  PORT?: string;
  OPENCLAW_BASE_URL?: string;
  OPENCLAW_HOOK_TOKEN?: string;
  OPENCLAW_HOOKS_TOKEN?: string;
  REGISTRY_URL?: string;
  CLAWDENTITY_REGISTRY_URL?: string;
  ENVIRONMENT?: string;
  ALLOW_LIST?: string;
  ALLOWLIST_OWNERS?: string;
  ALLOWLIST_AGENTS?: string;
  ALLOW_ALL_VERIFIED?: string;
  CRL_REFRESH_INTERVAL_MS?: string;
  CRL_MAX_AGE_MS?: string;
  CRL_STALE_BEHAVIOR?: string;
  AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE?: string;
  AGENT_RATE_LIMIT_WINDOW_MS?: string;
  INJECT_IDENTITY_INTO_MESSAGE?: string;
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
    env.OPENCLAW_HOOK_TOKEN,
    env.OPENCLAW_HOOKS_TOKEN,
    env.REGISTRY_URL,
    env.CLAWDENTITY_REGISTRY_URL,
    env.ENVIRONMENT,
    env.ALLOW_LIST,
    env.ALLOWLIST_OWNERS,
    env.ALLOWLIST_AGENTS,
    env.CRL_REFRESH_INTERVAL_MS,
    env.CRL_MAX_AGE_MS,
    env.CRL_STALE_BEHAVIOR,
    env.AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE,
    env.AGENT_RATE_LIMIT_WINDOW_MS,
    env.INJECT_IDENTITY_INTO_MESSAGE,
  ];

  return keyParts.map((value) => String(value ?? "")).join("|");
}

function buildRuntime(env: ProxyWorkerBindings): CachedProxyRuntime {
  const key = toCacheKey(env);
  if (cachedRuntime && cachedRuntime.key === key) {
    return cachedRuntime;
  }

  const config = parseProxyConfig(env);
  assertWorkerOpenclawBaseUrl(config);
  const app = createProxyApp({ config, logger });

  cachedRuntime = {
    key,
    app,
    config,
  };
  return cachedRuntime;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0.0.0.0"
  ) {
    return true;
  }

  const ipv4Match = normalized.match(/^(\d{1,3})(?:\.(\d{1,3})){3}$/);
  if (!ipv4Match) {
    return false;
  }

  const segments = normalized.split(".").map(Number);
  if (segments.some((segment) => Number.isNaN(segment) || segment > 255)) {
    return false;
  }

  return segments[0] === 127;
}

function assertWorkerOpenclawBaseUrl(config: ProxyConfig): void {
  if (config.environment === "local" || config.environment === "test") {
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(config.openclawBaseUrl);
  } catch {
    throw new ProxyConfigError("Proxy configuration is invalid", {
      fieldErrors: {
        OPENCLAW_BASE_URL: ["OPENCLAW_BASE_URL must be a valid absolute URL"],
      },
      formErrors: [],
    });
  }

  if (
    config.openclawBaseUrl === DEFAULT_OPENCLAW_BASE_URL ||
    isLoopbackHostname(parsed.hostname)
  ) {
    throw new ProxyConfigError("Proxy configuration is invalid", {
      fieldErrors: {
        OPENCLAW_BASE_URL: [
          "OPENCLAW_BASE_URL must be an externally reachable URL for deployed Worker environments",
        ],
      },
      formErrors: [],
    });
  }
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

export default worker;
