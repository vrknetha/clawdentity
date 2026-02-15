import type { ProxyConfig } from "./config.js";
import { loadProxyConfig } from "./config.js";

export const PROXY_VERSION = "0.0.0";

export type ProxyRuntime = {
  version: string;
  config: ProxyConfig;
};

function resolveDefaultEnv(): unknown {
  const nodeProcess = (globalThis as { process?: { env?: unknown } }).process;
  return nodeProcess?.env ?? {};
}

export function initializeProxyRuntime(
  env: unknown = resolveDefaultEnv(),
): ProxyRuntime {
  return {
    version: PROXY_VERSION,
    config: loadProxyConfig(env),
  };
}
