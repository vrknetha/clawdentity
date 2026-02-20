import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ProxyConfigLoadOptions } from "./defaults.js";
import {
  firstNonEmptyString,
  type RuntimeEnvInput,
  resolveDefaultCwd,
} from "./env-normalization.js";
import { toConfigValidationError } from "./errors.js";

const CLAWDENTITY_CONFIG_DIR = ".clawdentity";
const OPENCLAW_RELAY_CONFIG_FILENAME = "openclaw-relay.json";

export function resolvePathWithHome(
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

export function resolveHomeDir(
  env: RuntimeEnvInput,
  homeDirOverride?: string,
): string {
  if (homeDirOverride !== undefined && homeDirOverride.trim().length > 0) {
    return homeDirOverride.trim();
  }

  return firstNonEmptyString(env, ["HOME", "USERPROFILE"]) ?? homedir();
}

export function resolveStateDir(
  env: RuntimeEnvInput,
  options: ProxyConfigLoadOptions,
): string {
  const cwd = options.cwd ?? resolveDefaultCwd();
  const home = resolveHomeDir(env, options.homeDir);
  const stateDirOverride = firstNonEmptyString(env, ["OPENCLAW_STATE_DIR"]);

  if (stateDirOverride !== undefined) {
    return resolvePathWithHome(stateDirOverride, cwd, home);
  }

  return join(home, ".openclaw");
}

export function resolveOpenclawRelayConfigPath(
  env: RuntimeEnvInput,
  options: ProxyConfigLoadOptions,
): string {
  const home = resolveHomeDir(env, options.homeDir);
  return join(home, CLAWDENTITY_CONFIG_DIR, OPENCLAW_RELAY_CONFIG_FILENAME);
}

export function resolveBaseUrlFromRelayConfig(
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
