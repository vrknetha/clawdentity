import type { ProxyConfig } from "./config.js";
import { loadProxyConfig } from "./config.js";

export const PROXY_VERSION = "0.0.0";
const APP_VERSION_ENV_KEYS = ["APP_VERSION", "PROXY_VERSION"] as const;

export type ProxyRuntime = {
  version: string;
  config: ProxyConfig;
};

function resolveDefaultEnv(): unknown {
  const nodeProcess = (globalThis as { process?: { env?: unknown } }).process;
  return nodeProcess?.env ?? {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function resolveProxyVersion(
  env: unknown = resolveDefaultEnv(),
): string {
  if (!isRecord(env)) {
    return PROXY_VERSION;
  }

  for (const key of APP_VERSION_ENV_KEYS) {
    const candidate = env[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return PROXY_VERSION;
}

export function initializeProxyRuntime(
  env: unknown = resolveDefaultEnv(),
): ProxyRuntime {
  return {
    version: resolveProxyVersion(env),
    config: loadProxyConfig(env),
  };
}
