import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import dotenv from "dotenv";
import JSON5 from "json5";
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
export const DEFAULT_REGISTRY_URL = "https://api.clawdentity.com";
export const DEFAULT_PROXY_ENVIRONMENT: ProxyEnvironment = "development";
export const DEFAULT_CRL_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
export const DEFAULT_CRL_MAX_AGE_MS = 15 * 60 * 1000;
export const DEFAULT_CRL_STALE_BEHAVIOR: ProxyCrlStaleBehavior = "fail-open";
export const DEFAULT_AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE = 60;
export const DEFAULT_AGENT_RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const DEFAULT_INJECT_IDENTITY_INTO_MESSAGE = true;

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

const OPENCLAW_CONFIG_FILENAME = "openclaw.json";
const CLAWDENTITY_CONFIG_DIR = ".clawdentity";
const OPENCLAW_RELAY_CONFIG_FILENAME = "openclaw-relay.json";
const LEGACY_STATE_DIR_NAMES = [".clawdbot", ".moldbot", ".moltbot"] as const;

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
  OPENCLAW_HOOK_TOKEN: z.string().trim().min(1).optional(),
  REGISTRY_URL: z.string().trim().url().default(DEFAULT_REGISTRY_URL),
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
});

export const proxyConfigSchema = z.object({
  listenPort: z.number().int().min(1).max(65535),
  openclawBaseUrl: z.string().url(),
  openclawHookToken: z.string().min(1).optional(),
  registryUrl: z.string().url(),
  environment: z.enum(proxyEnvironmentValues),
  crlRefreshIntervalMs: z.number().int().positive(),
  crlMaxAgeMs: z.number().int().positive(),
  crlStaleBehavior: z.enum(["fail-open", "fail-closed"]),
  agentRateLimitRequestsPerMinute: z.number().int().positive(),
  agentRateLimitWindowMs: z.number().int().positive(),
  injectIdentityIntoMessage: z.boolean(),
});

export type ProxyConfig = z.infer<typeof proxyConfigSchema>;

type RuntimeEnvInput = {
  LISTEN_PORT?: unknown;
  PORT?: unknown;
  OPENCLAW_BASE_URL?: unknown;
  OPENCLAW_HOOK_TOKEN?: unknown;
  REGISTRY_URL?: unknown;
  CLAWDENTITY_REGISTRY_URL?: unknown;
  ENVIRONMENT?: unknown;
  ALLOW_ALL_VERIFIED?: unknown;
  CRL_REFRESH_INTERVAL_MS?: unknown;
  CRL_MAX_AGE_MS?: unknown;
  CRL_STALE_BEHAVIOR?: unknown;
  AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE?: unknown;
  AGENT_RATE_LIMIT_WINDOW_MS?: unknown;
  INJECT_IDENTITY_INTO_MESSAGE?: unknown;
  OPENCLAW_STATE_DIR?: unknown;
  OPENCLAW_CONFIG_PATH?: unknown;
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
  if (existsSync(canonicalStateDir)) {
    return canonicalStateDir;
  }

  for (const legacyDirName of LEGACY_STATE_DIR_NAMES) {
    const legacyStateDir = join(home, legacyDirName);
    if (existsSync(legacyStateDir)) {
      return legacyStateDir;
    }
  }

  return canonicalStateDir;
}

function resolveOpenClawConfigPath(
  env: RuntimeEnvInput,
  options: ProxyConfigLoadOptions,
): string {
  const cwd = options.cwd ?? resolveDefaultCwd();
  const home = resolveHomeDir(env, options.homeDir);
  const stateDir = resolveStateDir(env, options);
  const configPathOverride = firstNonEmptyString(env, ["OPENCLAW_CONFIG_PATH"]);

  if (configPathOverride !== undefined) {
    return resolvePathWithHome(configPathOverride, cwd, home);
  }

  return join(stateDir, OPENCLAW_CONFIG_FILENAME);
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

function resolveHookTokenFromOpenClawConfig(
  env: RuntimeEnvInput,
  options: ProxyConfigLoadOptions,
): string | undefined {
  const configPath = resolveOpenClawConfigPath(env, options);
  if (!existsSync(configPath)) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON5.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw toConfigValidationError({
      fieldErrors: {
        OPENCLAW_CONFIG_PATH: [
          `Unable to parse OpenClaw config at ${configPath}`,
        ],
      },
      formErrors: [
        error instanceof Error
          ? error.message
          : "Unknown OpenClaw config parse error",
      ],
    });
  }

  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }

  const hooksValue = (parsed as Record<string, unknown>).hooks;
  if (typeof hooksValue !== "object" || hooksValue === null) {
    return undefined;
  }

  const tokenValue = (hooksValue as Record<string, unknown>).token;
  if (tokenValue === undefined || tokenValue === null) {
    return undefined;
  }

  if (typeof tokenValue !== "string") {
    throw toConfigValidationError({
      fieldErrors: {
        OPENCLAW_CONFIG_PATH: ["hooks.token must be a string when set"],
      },
      formErrors: [],
    });
  }

  const trimmedToken = tokenValue.trim();
  return trimmedToken.length > 0 ? trimmedToken : undefined;
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
    OPENCLAW_HOOK_TOKEN: firstNonEmpty(env, ["OPENCLAW_HOOK_TOKEN"]),
    REGISTRY_URL: firstNonEmpty(env, [
      "REGISTRY_URL",
      "CLAWDENTITY_REGISTRY_URL",
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

function loadHookTokenFromFallback(
  env: MutableEnv,
  options: ProxyConfigLoadOptions,
): void {
  if (
    firstNonEmpty(env as RuntimeEnvInput, ["OPENCLAW_HOOK_TOKEN"]) !== undefined
  ) {
    return;
  }

  const token = resolveHookTokenFromOpenClawConfig(
    env as RuntimeEnvInput,
    options,
  );
  if (token !== undefined) {
    env.OPENCLAW_HOOK_TOKEN = token;
  }
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

export function parseProxyConfig(env: unknown): ProxyConfig {
  const inputEnv: RuntimeEnvInput = isRuntimeEnvInput(env) ? env : {};
  assertNoDeprecatedAllowAllVerified(inputEnv);

  const parsedRuntimeEnv = proxyRuntimeEnvSchema.safeParse(
    normalizeRuntimeEnv(inputEnv),
  );
  if (!parsedRuntimeEnv.success) {
    throw toConfigValidationError({
      fieldErrors: parsedRuntimeEnv.error.flatten().fieldErrors,
      formErrors: parsedRuntimeEnv.error.flatten().formErrors,
    });
  }

  const candidateConfig = {
    listenPort: parsedRuntimeEnv.data.LISTEN_PORT,
    openclawBaseUrl: parsedRuntimeEnv.data.OPENCLAW_BASE_URL,
    openclawHookToken: parsedRuntimeEnv.data.OPENCLAW_HOOK_TOKEN,
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
  };

  const parsedConfig = proxyConfigSchema.safeParse(candidateConfig);
  if (parsedConfig.success) {
    return parsedConfig.data;
  }

  throw toConfigValidationError({
    fieldErrors: parsedConfig.error.flatten().fieldErrors,
    formErrors: parsedConfig.error.flatten().formErrors,
  });
}

export function loadProxyConfig(
  env: unknown = resolveDefaultEnv(),
  options: ProxyConfigLoadOptions = {},
): ProxyConfig {
  const mergedEnv = loadEnvWithDotEnvFallback(env, options);
  loadOpenclawBaseUrlFromFallback(mergedEnv, options);
  loadHookTokenFromFallback(mergedEnv, options);
  return parseProxyConfig(mergedEnv);
}
