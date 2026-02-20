import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

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

export class ProxyConfigError extends Error {
  readonly code = "CONFIG_VALIDATION_FAILED";
  readonly status = 500;
  readonly expose = true;
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown>) {
    super(message);
    this.name = "ProxyConfigError";
    this.details = details;
  }
}

const CLAWDENTITY_CONFIG_DIR = ".clawdentity";
const OPENCLAW_RELAY_CONFIG_FILENAME = "openclaw-relay.json";

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

const proxyRuntimeEnvSchema = z.object({
  LISTEN_PORT: z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(DEFAULT_PROXY_LISTEN_PORT),
  OPENCLAW_BASE_URL: z.string().trim().url().default(DEFAULT_OPENCLAW_BASE_URL),
  REGISTRY_URL: z.string().trim().url().default(DEFAULT_REGISTRY_URL),
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
type ParseProxyConfigOptions = {
  requireRuntimeKeys?: boolean;
};

type RuntimeEnvInput = {
  LISTEN_PORT?: unknown;
  PORT?: unknown;
  OPENCLAW_BASE_URL?: unknown;
  REGISTRY_URL?: unknown;
  CLAWDENTITY_REGISTRY_URL?: unknown;
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

type MutableEnv = Record<string, unknown>;

function isRuntimeEnvInput(value: unknown): value is RuntimeEnvInput {
  return typeof value === "object" && value !== null;
}

function toConfigValidationError(
  details: Record<string, unknown>,
): ProxyConfigError {
  return new ProxyConfigError("Proxy configuration is invalid", details);
}

function firstNonEmpty(
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

function firstNonEmptyString(
  env: RuntimeEnvInput,
  keys: readonly (keyof RuntimeEnvInput)[],
): string | undefined {
  const value = firstNonEmpty(env, keys);
  return typeof value === "string" ? value : undefined;
}

function resolveDefaultEnv(): unknown {
  const nodeProcess = (globalThis as { process?: { env?: unknown } }).process;
  return nodeProcess?.env ?? {};
}

function resolveDefaultCwd(): string {
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

function resolvePathWithHome(
  inputPath: string,
  cwd: string,
  home: string,
): string {
  const trimmed = inputPath.trim();
  if (trimmed === "~") {
    return home;
  }

  if (trimmed.startsWith("~/")) {
    return resolve(home, trimmed.slice(2));
  }

  if (isAbsolute(trimmed)) {
    return trimmed;
  }

  return resolve(cwd, trimmed);
}

function resolveHomeDir(
  env: RuntimeEnvInput,
  homeDirOverride?: string,
): string {
  if (homeDirOverride !== undefined && homeDirOverride.trim().length > 0) {
    return homeDirOverride.trim();
  }

  return firstNonEmptyString(env, ["HOME", "USERPROFILE"]) ?? homedir();
}

function resolveStateDir(
  env: RuntimeEnvInput,
  options: ProxyConfigLoadOptions,
): string {
  const cwd = options.cwd ?? resolveDefaultCwd();
  const home = resolveHomeDir(env, options.homeDir);
  const stateDirOverride = firstNonEmptyString(env, ["OPENCLAW_STATE_DIR"]);

  if (stateDirOverride !== undefined) {
    return resolvePathWithHome(stateDirOverride, cwd, home);
  }

  const canonicalStateDir = join(home, ".openclaw");
  return canonicalStateDir;
}

function resolveOpenclawRelayConfigPath(
  env: RuntimeEnvInput,
  options: ProxyConfigLoadOptions,
): string {
  const home = resolveHomeDir(env, options.homeDir);
  return join(home, CLAWDENTITY_CONFIG_DIR, OPENCLAW_RELAY_CONFIG_FILENAME);
}

function mergeMissingEnvValues(
  target: MutableEnv,
  values: Record<string, string>,
): void {
  for (const [key, value] of Object.entries(values)) {
    const existingValue = target[key];
    if (existingValue !== undefined && existingValue !== null) {
      if (typeof existingValue !== "string" || existingValue.trim() !== "") {
        continue;
      }
    }

    if (value.trim() === "") {
      continue;
    }

    target[key] = value;
  }
}

function parseDotEnvFile(filePath: string): Record<string, string> {
  try {
    const raw = readFileSync(filePath, "utf8");
    return dotenv.parse(raw);
  } catch (error) {
    throw toConfigValidationError({
      fieldErrors: {
        DOTENV: [`Unable to parse dotenv file at ${filePath}`],
      },
      formErrors: [
        error instanceof Error ? error.message : "Unknown dotenv parse error",
      ],
    });
  }
}

function loadEnvWithDotEnvFallback(
  env: unknown,
  options: ProxyConfigLoadOptions,
): MutableEnv {
  const mergedEnv: MutableEnv = isRuntimeEnvInput(env) ? { ...env } : {};
  const cwd = options.cwd ?? resolveDefaultCwd();
  const cwdDotEnvPath = join(cwd, ".env");
  if (existsSync(cwdDotEnvPath)) {
    mergeMissingEnvValues(mergedEnv, parseDotEnvFile(cwdDotEnvPath));
  }

  const stateDir = resolveStateDir(mergedEnv as RuntimeEnvInput, options);
  const stateDotEnvPath = join(stateDir, ".env");
  if (existsSync(stateDotEnvPath)) {
    mergeMissingEnvValues(mergedEnv, parseDotEnvFile(stateDotEnvPath));
  }

  return mergedEnv;
}

function resolveBaseUrlFromRelayConfig(
  env: RuntimeEnvInput,
  options: ProxyConfigLoadOptions,
): string | undefined {
  const configPath = resolveOpenclawRelayConfigPath(env, options);
  if (!existsSync(configPath)) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw toConfigValidationError({
      fieldErrors: {
        OPENCLAW_RELAY_CONFIG_PATH: [
          `Unable to parse relay config at ${configPath}`,
        ],
      },
      formErrors: [
        error instanceof Error ? error.message : "Unknown relay parse error",
      ],
    });
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw toConfigValidationError({
      fieldErrors: {
        OPENCLAW_RELAY_CONFIG_PATH: ["Relay config root must be a JSON object"],
      },
      formErrors: [],
    });
  }

  const baseUrlValue = (parsed as Record<string, unknown>).openclawBaseUrl;
  if (typeof baseUrlValue !== "string" || baseUrlValue.trim().length === 0) {
    throw toConfigValidationError({
      fieldErrors: {
        OPENCLAW_RELAY_CONFIG_PATH: [
          "openclawBaseUrl must be a non-empty string",
        ],
      },
      formErrors: [],
    });
  }

  const trimmed = baseUrlValue.trim();
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    throw toConfigValidationError({
      fieldErrors: {
        OPENCLAW_RELAY_CONFIG_PATH: [
          "openclawBaseUrl must be a valid absolute URL",
        ],
      },
      formErrors: [],
    });
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw toConfigValidationError({
      fieldErrors: {
        OPENCLAW_RELAY_CONFIG_PATH: ["openclawBaseUrl must use http or https"],
      },
      formErrors: [],
    });
  }

  if (
    parsedUrl.pathname === "/" &&
    parsedUrl.search.length === 0 &&
    parsedUrl.hash.length === 0
  ) {
    return parsedUrl.origin;
  }

  return parsedUrl.toString();
}

function normalizeRuntimeEnv(input: unknown): Record<string, unknown> {
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
    ]),
    REGISTRY_INTERNAL_SERVICE_SECRET: firstNonEmpty(env, [
      "REGISTRY_INTERNAL_SERVICE_SECRET",
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

function assertNoDeprecatedAllowAllVerified(env: RuntimeEnvInput): void {
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

function loadOpenclawBaseUrlFromFallback(
  env: MutableEnv,
  options: ProxyConfigLoadOptions,
): void {
  if (
    firstNonEmpty(env as RuntimeEnvInput, ["OPENCLAW_BASE_URL"]) !== undefined
  ) {
    return;
  }

  const openclawBaseUrl = resolveBaseUrlFromRelayConfig(
    env as RuntimeEnvInput,
    options,
  );
  if (openclawBaseUrl !== undefined) {
    env.OPENCLAW_BASE_URL = openclawBaseUrl;
  }
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
    key: "REGISTRY_URL",
    aliases: ["REGISTRY_URL", "CLAWDENTITY_REGISTRY_URL"],
  },
  {
    key: "REGISTRY_INTERNAL_SERVICE_ID",
    aliases: ["REGISTRY_INTERNAL_SERVICE_ID"],
  },
  {
    key: "REGISTRY_INTERNAL_SERVICE_SECRET",
    aliases: ["REGISTRY_INTERNAL_SERVICE_SECRET"],
  },
];

function assertRequiredProxyRuntimeKeys(env: RuntimeEnvInput): void {
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
    registryUrl: parsedRuntimeEnv.data.REGISTRY_URL,
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
          REGISTRY_INTERNAL_SERVICE_ID: [
            "REGISTRY_INTERNAL_SERVICE_ID and REGISTRY_INTERNAL_SERVICE_SECRET must be set together.",
          ],
          REGISTRY_INTERNAL_SERVICE_SECRET: [
            "REGISTRY_INTERNAL_SERVICE_ID and REGISTRY_INTERNAL_SERVICE_SECRET must be set together.",
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
