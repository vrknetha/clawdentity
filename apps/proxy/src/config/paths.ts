import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ProxyConfigLoadOptions } from "./defaults.js";
import {
  firstNonEmptyString,
  type RuntimeEnvInput,
  resolveDefaultCwd,
} from "./env-normalization.js";

const CLAWDENTITY_CONFIG_DIR = ".clawdentity";

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
  const stateDirOverride = firstNonEmptyString(env, ["DELIVERY_STATE_DIR"]);

  if (stateDirOverride !== undefined) {
    return resolvePathWithHome(stateDirOverride, cwd, home);
  }

  return join(home, CLAWDENTITY_CONFIG_DIR);
}
