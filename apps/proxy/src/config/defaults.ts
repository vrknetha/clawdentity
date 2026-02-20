export type ProxyCrlStaleBehavior = "fail-open" | "fail-closed";
export const proxyEnvironmentValues = [
  "local",
  "development",
  "production",
  "test",
] as const;
export type ProxyEnvironment = (typeof proxyEnvironmentValues)[number];

export type ProxyConfigLoadOptions = {
  cwd?: string;
  homeDir?: string;
};

export const DEFAULT_PROXY_LISTEN_PORT = 4000;
export const DEFAULT_OPENCLAW_BASE_URL = "http://127.0.0.1:18789";
export const DEFAULT_REGISTRY_URL = "https://registry.clawdentity.com";
export const DEFAULT_PROXY_ENVIRONMENT: ProxyEnvironment = "development";
export const DEFAULT_CRL_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
export const DEFAULT_CRL_MAX_AGE_MS = 15 * 60 * 1000;
export const DEFAULT_CRL_STALE_BEHAVIOR: ProxyCrlStaleBehavior = "fail-open";
export const DEFAULT_AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE = 60;
export const DEFAULT_AGENT_RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const DEFAULT_INJECT_IDENTITY_INTO_MESSAGE = true;
export const DEFAULT_RELAY_QUEUE_MAX_MESSAGES_PER_AGENT = 500;
export const DEFAULT_RELAY_QUEUE_TTL_SECONDS = 3600;
export const DEFAULT_RELAY_RETRY_INITIAL_MS = 1000;
export const DEFAULT_RELAY_RETRY_MAX_MS = 30_000;
export const DEFAULT_RELAY_RETRY_MAX_ATTEMPTS = 25;
export const DEFAULT_RELAY_RETRY_JITTER_RATIO = 0.2;
export const DEFAULT_RELAY_MAX_IN_FLIGHT_DELIVERIES = 5;
export const DEFAULT_RELAY_MAX_FRAME_BYTES = 1024 * 1024;
