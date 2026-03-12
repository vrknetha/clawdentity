import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import dotenv from "dotenv";
import type { ProxyConfigLoadOptions } from "./defaults.js";
import {
  firstNonEmpty,
  isRuntimeEnvInput,
  type MutableEnv,
  type RuntimeEnvInput,
  resolveDefaultCwd,
} from "./env-normalization.js";
import { toConfigValidationError } from "./errors.js";
import { resolveBaseUrlFromRelayConfig, resolveStateDir } from "./paths.js";

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

export function loadEnvWithDotEnvFallback(
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

export function loadOpenclawBaseUrlFromFallback(
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
