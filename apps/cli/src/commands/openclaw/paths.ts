import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { getConfigDir } from "../../config/manager.js";
import {
  AGENTS_DIR_NAME,
  LEGACY_OPENCLAW_CONFIG_FILE_NAMES,
  LEGACY_OPENCLAW_STATE_DIR_NAMES,
  OPENCLAW_AGENT_FILE_NAME,
  OPENCLAW_CONFIG_FILE_NAME,
  OPENCLAW_CONNECTORS_FILE_NAME,
  OPENCLAW_DIR_NAME,
  OPENCLAW_RELAY_RUNTIME_FILE_NAME,
  PEERS_FILE_NAME,
  RELAY_MODULE_FILE_NAME,
  RELAY_PEERS_FILE_NAME,
  RELAY_RUNTIME_FILE_NAME,
  SKILL_DIR_NAME,
} from "./constants.js";

export function resolveHomeDir(homeDir?: string): string {
  if (typeof homeDir === "string" && homeDir.trim().length > 0) {
    return homeDir.trim();
  }

  return homedir();
}

export function resolveHomePrefixedPath(
  input: string,
  homeDir: string,
): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("~")) {
    return resolvePath(trimmed.replace(/^~(?=$|[\\/])/, homeDir));
  }
  return resolvePath(trimmed);
}

export function readNonEmptyEnvPath(
  value: string | undefined,
  homeDir: string,
): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  return resolveHomePrefixedPath(value, homeDir);
}

export function resolveOpenclawHomeDir(homeDir: string): string {
  const envOpenclawHome = readNonEmptyEnvPath(
    process.env.OPENCLAW_HOME,
    homeDir,
  );
  return envOpenclawHome ?? homeDir;
}

export function resolveDefaultOpenclawStateDir(
  openclawHomeDir: string,
): string {
  const newStateDir = join(openclawHomeDir, OPENCLAW_DIR_NAME);
  if (existsSync(newStateDir)) {
    return newStateDir;
  }

  for (const legacyDirName of LEGACY_OPENCLAW_STATE_DIR_NAMES) {
    const legacyStateDir = join(openclawHomeDir, legacyDirName);
    if (existsSync(legacyStateDir)) {
      return legacyStateDir;
    }
  }

  return newStateDir;
}

export function resolveOpenclawDir(
  openclawDir: string | undefined,
  homeDir: string,
): string {
  if (typeof openclawDir === "string" && openclawDir.trim().length > 0) {
    return resolveHomePrefixedPath(openclawDir, homeDir);
  }

  const envStateDir = readNonEmptyEnvPath(
    process.env.OPENCLAW_STATE_DIR ?? process.env.CLAWDBOT_STATE_DIR,
    homeDir,
  );
  if (envStateDir !== undefined) {
    return envStateDir;
  }

  const envConfigPath = readNonEmptyEnvPath(
    process.env.OPENCLAW_CONFIG_PATH ?? process.env.CLAWDBOT_CONFIG_PATH,
    homeDir,
  );
  if (envConfigPath !== undefined) {
    return dirname(envConfigPath);
  }

  const openclawHomeDir = resolveOpenclawHomeDir(homeDir);
  return resolveDefaultOpenclawStateDir(openclawHomeDir);
}

export function resolveAgentDirectory(
  homeDir: string,
  agentName: string,
): string {
  return join(getConfigDir({ homeDir }), AGENTS_DIR_NAME, agentName);
}

export function resolvePeersPath(homeDir: string): string {
  return join(getConfigDir({ homeDir }), PEERS_FILE_NAME);
}

export function resolveOpenclawConfigPath(
  openclawDir: string,
  homeDir: string,
): string {
  const envConfigPath = readNonEmptyEnvPath(
    process.env.OPENCLAW_CONFIG_PATH ?? process.env.CLAWDBOT_CONFIG_PATH,
    homeDir,
  );
  if (envConfigPath !== undefined) {
    return envConfigPath;
  }

  const configCandidates = [
    join(openclawDir, OPENCLAW_CONFIG_FILE_NAME),
    ...LEGACY_OPENCLAW_CONFIG_FILE_NAMES.map((fileName) =>
      join(openclawDir, fileName),
    ),
  ];

  for (const candidate of configCandidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return configCandidates[0];
}

export function resolveDefaultTransformSource(openclawDir: string): string {
  return join(openclawDir, "skills", SKILL_DIR_NAME, RELAY_MODULE_FILE_NAME);
}

export function resolveTransformTargetPath(openclawDir: string): string {
  return join(openclawDir, "hooks", "transforms", RELAY_MODULE_FILE_NAME);
}

export function resolveOpenclawAgentNamePath(homeDir: string): string {
  return join(getConfigDir({ homeDir }), OPENCLAW_AGENT_FILE_NAME);
}

export function resolveRelayRuntimeConfigPath(homeDir: string): string {
  return join(getConfigDir({ homeDir }), OPENCLAW_RELAY_RUNTIME_FILE_NAME);
}

export function resolveConnectorAssignmentsPath(homeDir: string): string {
  return join(getConfigDir({ homeDir }), OPENCLAW_CONNECTORS_FILE_NAME);
}

export function resolveTransformRuntimePath(openclawDir: string): string {
  return join(openclawDir, "hooks", "transforms", RELAY_RUNTIME_FILE_NAME);
}

export function resolveTransformPeersPath(openclawDir: string): string {
  return join(openclawDir, "hooks", "transforms", RELAY_PEERS_FILE_NAME);
}
