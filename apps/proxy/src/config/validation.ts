import type { ProxyConfigLoadOptions } from "./defaults.js";
import { resolveDefaultRegistryUrl } from "./defaults.js";
import {
  assertNoDeprecatedAllowAllVerified,
  assertRequiredProxyRuntimeKeys,
  isRuntimeEnvInput,
  normalizeRuntimeEnv,
  type RuntimeEnvInput,
  resolveDefaultEnv,
} from "./env-normalization.js";
import { toConfigValidationError } from "./errors.js";
import {
  loadEnvWithDotEnvFallback,
  loadOpenclawBaseUrlFromFallback,
} from "./files.js";
import {
  type ProxyConfig,
  proxyConfigSchema,
  proxyRuntimeEnvSchema,
} from "./schema.js";

type ParseProxyConfigOptions = {
  requireRuntimeKeys?: boolean;
};

export function parseProxyConfig(
  env: unknown,
  options: ParseProxyConfigOptions = {},
): ProxyConfig {
  const inputEnv: RuntimeEnvInput = isRuntimeEnvInput(env) ? env : {};
  assertNoDeprecatedAllowAllVerified(inputEnv);
  if (options.requireRuntimeKeys === true) {
    assertRequiredProxyRuntimeKeys(inputEnv);
  }

  const parsedRuntimeEnv = proxyRuntimeEnvSchema.safeParse(
    normalizeRuntimeEnv(inputEnv),
  );
  if (!parsedRuntimeEnv.success) {
    throw toConfigValidationError({
      fieldErrors: parsedRuntimeEnv.error.flatten().fieldErrors,
      formErrors: parsedRuntimeEnv.error.flatten().formErrors,
    });
  }

  const candidateConfig: Record<string, unknown> = {
    listenPort: parsedRuntimeEnv.data.LISTEN_PORT,
    openclawBaseUrl: parsedRuntimeEnv.data.OPENCLAW_BASE_URL,
    registryUrl:
      parsedRuntimeEnv.data.REGISTRY_URL ??
      resolveDefaultRegistryUrl(parsedRuntimeEnv.data.ENVIRONMENT),
    environment: parsedRuntimeEnv.data.ENVIRONMENT,
    crlRefreshIntervalMs: parsedRuntimeEnv.data.CRL_REFRESH_INTERVAL_MS,
    crlMaxAgeMs: parsedRuntimeEnv.data.CRL_MAX_AGE_MS,
    crlStaleBehavior: parsedRuntimeEnv.data.CRL_STALE_BEHAVIOR,
    agentRateLimitRequestsPerMinute:
      parsedRuntimeEnv.data.AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE,
    agentRateLimitWindowMs: parsedRuntimeEnv.data.AGENT_RATE_LIMIT_WINDOW_MS,
    injectIdentityIntoMessage:
      parsedRuntimeEnv.data.INJECT_IDENTITY_INTO_MESSAGE,
    relayQueueMaxMessagesPerAgent:
      parsedRuntimeEnv.data.RELAY_QUEUE_MAX_MESSAGES_PER_AGENT,
    relayQueueTtlSeconds: parsedRuntimeEnv.data.RELAY_QUEUE_TTL_SECONDS,
    relayRetryInitialMs: parsedRuntimeEnv.data.RELAY_RETRY_INITIAL_MS,
    relayRetryMaxMs: parsedRuntimeEnv.data.RELAY_RETRY_MAX_MS,
    relayRetryMaxAttempts: parsedRuntimeEnv.data.RELAY_RETRY_MAX_ATTEMPTS,
    relayRetryJitterRatio: parsedRuntimeEnv.data.RELAY_RETRY_JITTER_RATIO,
    relayMaxInFlightDeliveries:
      parsedRuntimeEnv.data.RELAY_MAX_IN_FLIGHT_DELIVERIES,
    relayMaxFrameBytes: parsedRuntimeEnv.data.RELAY_MAX_FRAME_BYTES,
  };
  if (parsedRuntimeEnv.data.REGISTRY_INTERNAL_SERVICE_ID !== undefined) {
    candidateConfig.registryInternalServiceId =
      parsedRuntimeEnv.data.REGISTRY_INTERNAL_SERVICE_ID;
  }
  if (parsedRuntimeEnv.data.REGISTRY_INTERNAL_SERVICE_SECRET !== undefined) {
    candidateConfig.registryInternalServiceSecret =
      parsedRuntimeEnv.data.REGISTRY_INTERNAL_SERVICE_SECRET;
  }

  const parsedConfig = proxyConfigSchema.safeParse(candidateConfig);
  if (parsedConfig.success) {
    const hasServiceId =
      typeof parsedConfig.data.registryInternalServiceId === "string";
    const hasServiceSecret =
      typeof parsedConfig.data.registryInternalServiceSecret === "string";
    if (hasServiceId !== hasServiceSecret) {
      throw toConfigValidationError({
        fieldErrors: {
          BOOTSTRAP_INTERNAL_SERVICE_ID: [
            "BOOTSTRAP_INTERNAL_SERVICE_ID and BOOTSTRAP_INTERNAL_SERVICE_SECRET must be set together.",
          ],
          BOOTSTRAP_INTERNAL_SERVICE_SECRET: [
            "BOOTSTRAP_INTERNAL_SERVICE_ID and BOOTSTRAP_INTERNAL_SERVICE_SECRET must be set together.",
          ],
        },
        formErrors: [],
      });
    }
    if (
      parsedConfig.data.relayRetryMaxMs < parsedConfig.data.relayRetryInitialMs
    ) {
      throw toConfigValidationError({
        fieldErrors: {
          RELAY_RETRY_MAX_MS: [
            "RELAY_RETRY_MAX_MS must be greater than or equal to RELAY_RETRY_INITIAL_MS.",
          ],
          RELAY_RETRY_INITIAL_MS: [
            "RELAY_RETRY_MAX_MS must be greater than or equal to RELAY_RETRY_INITIAL_MS.",
          ],
        },
        formErrors: [],
      });
    }
    return parsedConfig.data;
  }

  throw toConfigValidationError({
    fieldErrors: parsedConfig.error.flatten().fieldErrors,
    formErrors: parsedConfig.error.flatten().formErrors,
  });
}

export function loadProxyConfig(
  env: unknown = resolveDefaultEnv(),
  options: ProxyConfigLoadOptions & ParseProxyConfigOptions = {},
): ProxyConfig {
  const mergedEnv = loadEnvWithDotEnvFallback(env, options);
  loadOpenclawBaseUrlFromFallback(mergedEnv, options);
  return parseProxyConfig(mergedEnv, options);
}
