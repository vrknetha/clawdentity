import { toConfigValidationError } from "./errors.js";

export type RuntimeEnvInput = {
  LISTEN_PORT?: unknown;
  PORT?: unknown;
  OPENCLAW_BASE_URL?: unknown;
  REGISTRY_URL?: unknown;
  CLAWDENTITY_REGISTRY_URL?: unknown;
  BOOTSTRAP_INTERNAL_SERVICE_ID?: unknown;
  BOOTSTRAP_INTERNAL_SERVICE_SECRET?: unknown;
  REGISTRY_INTERNAL_SERVICE_ID?: unknown;
  REGISTRY_INTERNAL_SERVICE_SECRET?: unknown;
  ENVIRONMENT?: unknown;
  ALLOW_ALL_VERIFIED?: unknown;
  CRL_REFRESH_INTERVAL_MS?: unknown;
  CRL_MAX_AGE_MS?: unknown;
  CRL_STALE_BEHAVIOR?: unknown;
  AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE?: unknown;
  AGENT_RATE_LIMIT_WINDOW_MS?: unknown;
  INJECT_IDENTITY_INTO_MESSAGE?: unknown;
  RELAY_QUEUE_MAX_MESSAGES_PER_AGENT?: unknown;
  RELAY_QUEUE_TTL_SECONDS?: unknown;
  RELAY_RETRY_INITIAL_MS?: unknown;
  RELAY_RETRY_MAX_MS?: unknown;
  RELAY_RETRY_MAX_ATTEMPTS?: unknown;
  RELAY_RETRY_JITTER_RATIO?: unknown;
  RELAY_MAX_IN_FLIGHT_DELIVERIES?: unknown;
  RELAY_MAX_FRAME_BYTES?: unknown;
  OPENCLAW_STATE_DIR?: unknown;
  HOME?: unknown;
  USERPROFILE?: unknown;
};

export type MutableEnv = Record<string, unknown>;

export function isRuntimeEnvInput(value: unknown): value is RuntimeEnvInput {
  return typeof value === "object" && value !== null;
}

export function firstNonEmpty(
  env: RuntimeEnvInput,
  keys: readonly (keyof RuntimeEnvInput)[],
): unknown {
  for (const key of keys) {
    const rawValue = env[key];
    if (rawValue === undefined || rawValue === null) {
      continue;
    }

    if (typeof rawValue === "string") {
      const trimmed = rawValue.trim();
      if (trimmed.length === 0) {
        continue;
      }

      return trimmed;
    }

    return rawValue;
  }

  return undefined;
}

export function firstNonEmptyString(
  env: RuntimeEnvInput,
  keys: readonly (keyof RuntimeEnvInput)[],
): string | undefined {
  const value = firstNonEmpty(env, keys);
  return typeof value === "string" ? value : undefined;
}

export function resolveDefaultEnv(): unknown {
  const nodeProcess = (globalThis as { process?: { env?: unknown } }).process;
  return nodeProcess?.env ?? {};
}

export function resolveDefaultCwd(): string {
  const nodeProcess = (
    globalThis as {
      process?: {
        cwd?: () => string;
      };
    }
  ).process;
  if (typeof nodeProcess?.cwd === "function") {
    return nodeProcess.cwd();
  }

  return ".";
}

export function normalizeRuntimeEnv(input: unknown): Record<string, unknown> {
  const env: RuntimeEnvInput = isRuntimeEnvInput(input) ? input : {};

  return {
    LISTEN_PORT: firstNonEmpty(env, ["LISTEN_PORT", "PORT"]),
    OPENCLAW_BASE_URL: firstNonEmpty(env, ["OPENCLAW_BASE_URL"]),
    REGISTRY_URL: firstNonEmpty(env, [
      "REGISTRY_URL",
      "CLAWDENTITY_REGISTRY_URL",
    ]),
    REGISTRY_INTERNAL_SERVICE_ID: firstNonEmpty(env, [
      "REGISTRY_INTERNAL_SERVICE_ID",
      "BOOTSTRAP_INTERNAL_SERVICE_ID",
    ]),
    REGISTRY_INTERNAL_SERVICE_SECRET: firstNonEmpty(env, [
      "REGISTRY_INTERNAL_SERVICE_SECRET",
      "BOOTSTRAP_INTERNAL_SERVICE_SECRET",
    ]),
    ENVIRONMENT: firstNonEmpty(env, ["ENVIRONMENT"]),
    CRL_REFRESH_INTERVAL_MS: firstNonEmpty(env, ["CRL_REFRESH_INTERVAL_MS"]),
    CRL_MAX_AGE_MS: firstNonEmpty(env, ["CRL_MAX_AGE_MS"]),
    CRL_STALE_BEHAVIOR: firstNonEmpty(env, ["CRL_STALE_BEHAVIOR"]),
    AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE: firstNonEmpty(env, [
      "AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE",
    ]),
    AGENT_RATE_LIMIT_WINDOW_MS: firstNonEmpty(env, [
      "AGENT_RATE_LIMIT_WINDOW_MS",
    ]),
    INJECT_IDENTITY_INTO_MESSAGE: firstNonEmpty(env, [
      "INJECT_IDENTITY_INTO_MESSAGE",
    ]),
    RELAY_QUEUE_MAX_MESSAGES_PER_AGENT: firstNonEmpty(env, [
      "RELAY_QUEUE_MAX_MESSAGES_PER_AGENT",
    ]),
    RELAY_QUEUE_TTL_SECONDS: firstNonEmpty(env, ["RELAY_QUEUE_TTL_SECONDS"]),
    RELAY_RETRY_INITIAL_MS: firstNonEmpty(env, ["RELAY_RETRY_INITIAL_MS"]),
    RELAY_RETRY_MAX_MS: firstNonEmpty(env, ["RELAY_RETRY_MAX_MS"]),
    RELAY_RETRY_MAX_ATTEMPTS: firstNonEmpty(env, ["RELAY_RETRY_MAX_ATTEMPTS"]),
    RELAY_RETRY_JITTER_RATIO: firstNonEmpty(env, ["RELAY_RETRY_JITTER_RATIO"]),
    RELAY_MAX_IN_FLIGHT_DELIVERIES: firstNonEmpty(env, [
      "RELAY_MAX_IN_FLIGHT_DELIVERIES",
    ]),
    RELAY_MAX_FRAME_BYTES: firstNonEmpty(env, ["RELAY_MAX_FRAME_BYTES"]),
  };
}

export function assertNoDeprecatedAllowAllVerified(env: RuntimeEnvInput): void {
  const value = env.ALLOW_ALL_VERIFIED;
  if (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim().length === 0)
  ) {
    return;
  }

  throw toConfigValidationError({
    fieldErrors: {
      ALLOW_ALL_VERIFIED: ["ALLOW_ALL_VERIFIED is no longer supported."],
    },
    formErrors: [],
  });
}

const REQUIRED_PROXY_RUNTIME_ENV_KEYS: readonly {
  key: string;
  aliases: readonly (keyof RuntimeEnvInput)[];
}[] = [
  {
    key: "ENVIRONMENT",
    aliases: ["ENVIRONMENT"],
  },
  {
    key: "BOOTSTRAP_INTERNAL_SERVICE_ID",
    aliases: ["BOOTSTRAP_INTERNAL_SERVICE_ID", "REGISTRY_INTERNAL_SERVICE_ID"],
  },
  {
    key: "BOOTSTRAP_INTERNAL_SERVICE_SECRET",
    aliases: [
      "BOOTSTRAP_INTERNAL_SERVICE_SECRET",
      "REGISTRY_INTERNAL_SERVICE_SECRET",
    ],
  },
];

export function assertRequiredProxyRuntimeKeys(env: RuntimeEnvInput): void {
  const fieldErrors: Record<string, string[]> = {};
  for (const requiredKey of REQUIRED_PROXY_RUNTIME_ENV_KEYS) {
    const value = firstNonEmpty(env, requiredKey.aliases);
    if (value !== undefined) {
      continue;
    }

    fieldErrors[requiredKey.key] = [`${requiredKey.key} is required`];
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw toConfigValidationError({
      fieldErrors,
      formErrors: [],
    });
  }
}
