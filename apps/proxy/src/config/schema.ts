import { z } from "zod";
import {
  DEFAULT_AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE,
  DEFAULT_AGENT_RATE_LIMIT_WINDOW_MS,
  DEFAULT_CRL_MAX_AGE_MS,
  DEFAULT_CRL_REFRESH_INTERVAL_MS,
  DEFAULT_CRL_STALE_BEHAVIOR,
  DEFAULT_INJECT_IDENTITY_INTO_MESSAGE,
  DEFAULT_OPENCLAW_BASE_URL,
  DEFAULT_PROXY_ENVIRONMENT,
  DEFAULT_PROXY_LISTEN_PORT,
  DEFAULT_RELAY_MAX_FRAME_BYTES,
  DEFAULT_RELAY_MAX_IN_FLIGHT_DELIVERIES,
  DEFAULT_RELAY_QUEUE_MAX_MESSAGES_PER_AGENT,
  DEFAULT_RELAY_QUEUE_TTL_SECONDS,
  DEFAULT_RELAY_RETRY_INITIAL_MS,
  DEFAULT_RELAY_RETRY_JITTER_RATIO,
  DEFAULT_RELAY_RETRY_MAX_ATTEMPTS,
  DEFAULT_RELAY_RETRY_MAX_MS,
  proxyEnvironmentValues,
} from "./defaults.js";

const envBooleanSchema = z.preprocess((value) => {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (
      normalized === "true" ||
      normalized === "1" ||
      normalized === "yes" ||
      normalized === "on"
    ) {
      return true;
    }

    if (
      normalized === "false" ||
      normalized === "0" ||
      normalized === "no" ||
      normalized === "off"
    ) {
      return false;
    }
  }

  return value;
}, z.boolean());

export const proxyRuntimeEnvSchema = z.object({
  LISTEN_PORT: z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(DEFAULT_PROXY_LISTEN_PORT),
  OPENCLAW_BASE_URL: z.string().trim().url().default(DEFAULT_OPENCLAW_BASE_URL),
  REGISTRY_URL: z.string().trim().url().optional(),
  REGISTRY_INTERNAL_SERVICE_ID: z.string().trim().min(1).optional(),
  REGISTRY_INTERNAL_SERVICE_SECRET: z.string().trim().min(1).optional(),
  ENVIRONMENT: z
    .enum(proxyEnvironmentValues)
    .default(DEFAULT_PROXY_ENVIRONMENT),
  CRL_REFRESH_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_CRL_REFRESH_INTERVAL_MS),
  CRL_MAX_AGE_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_CRL_MAX_AGE_MS),
  CRL_STALE_BEHAVIOR: z
    .enum(["fail-open", "fail-closed"])
    .default(DEFAULT_CRL_STALE_BEHAVIOR),
  AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE),
  AGENT_RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_AGENT_RATE_LIMIT_WINDOW_MS),
  INJECT_IDENTITY_INTO_MESSAGE: envBooleanSchema.default(
    DEFAULT_INJECT_IDENTITY_INTO_MESSAGE,
  ),
  RELAY_QUEUE_MAX_MESSAGES_PER_AGENT: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_RELAY_QUEUE_MAX_MESSAGES_PER_AGENT),
  RELAY_QUEUE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_RELAY_QUEUE_TTL_SECONDS),
  RELAY_RETRY_INITIAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_RELAY_RETRY_INITIAL_MS),
  RELAY_RETRY_MAX_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_RELAY_RETRY_MAX_MS),
  RELAY_RETRY_MAX_ATTEMPTS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_RELAY_RETRY_MAX_ATTEMPTS),
  RELAY_RETRY_JITTER_RATIO: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(DEFAULT_RELAY_RETRY_JITTER_RATIO),
  RELAY_MAX_IN_FLIGHT_DELIVERIES: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_RELAY_MAX_IN_FLIGHT_DELIVERIES),
  RELAY_MAX_FRAME_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_RELAY_MAX_FRAME_BYTES),
});

export const proxyConfigSchema = z.object({
  listenPort: z.number().int().min(1).max(65535),
  openclawBaseUrl: z.string().url(),
  registryUrl: z.string().url(),
  registryInternalServiceId: z.string().min(1).optional(),
  registryInternalServiceSecret: z.string().min(1).optional(),
  environment: z.enum(proxyEnvironmentValues),
  crlRefreshIntervalMs: z.number().int().positive(),
  crlMaxAgeMs: z.number().int().positive(),
  crlStaleBehavior: z.enum(["fail-open", "fail-closed"]),
  agentRateLimitRequestsPerMinute: z.number().int().positive(),
  agentRateLimitWindowMs: z.number().int().positive(),
  injectIdentityIntoMessage: z.boolean(),
  relayQueueMaxMessagesPerAgent: z.number().int().positive(),
  relayQueueTtlSeconds: z.number().int().positive(),
  relayRetryInitialMs: z.number().int().positive(),
  relayRetryMaxMs: z.number().int().positive(),
  relayRetryMaxAttempts: z.number().int().positive(),
  relayRetryJitterRatio: z.number().min(0).max(1),
  relayMaxInFlightDeliveries: z.number().int().positive(),
  relayMaxFrameBytes: z.number().int().positive(),
});

export type ProxyConfig = z.infer<typeof proxyConfigSchema>;
