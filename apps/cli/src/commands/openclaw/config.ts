import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import {
  createCliError,
  getErrorCode,
  isRecord,
  normalizeStringArrayWithValues,
} from "./common.js";
import {
  DEFAULT_OPENCLAW_MAIN_SESSION_KEY,
  HOOK_MAPPING_ID,
  HOOK_PATH_SEND_TO_PEER,
  OPENCLAW_HOOK_TOKEN_BYTES,
  RELAY_MODULE_FILE_NAME,
} from "./constants.js";
import { readJsonFile } from "./state.js";

export function resolveHookDefaultSessionKey(
  config: Record<string, unknown>,
  hooks: Record<string, unknown>,
): string {
  const session = isRecord(config.session) ? config.session : {};
  const scope =
    typeof session.scope === "string" ? session.scope.trim().toLowerCase() : "";
  const configuredMainSessionKey =
    resolveConfiguredOpenclawMainSessionKey(session);

  if (
    typeof hooks.defaultSessionKey === "string" &&
    hooks.defaultSessionKey.trim().length > 0
  ) {
    return normalizeLegacyHookDefaultSessionKey(
      hooks.defaultSessionKey,
      configuredMainSessionKey,
    );
  }

  if (scope === "global") {
    return "global";
  }

  return configuredMainSessionKey;
}

function resolveConfiguredOpenclawMainSessionKey(
  session: Record<string, unknown>,
): string {
  if (
    typeof session.mainKey === "string" &&
    session.mainKey.trim().length > 0
  ) {
    return session.mainKey.trim();
  }

  return DEFAULT_OPENCLAW_MAIN_SESSION_KEY;
}

function normalizeLegacyHookDefaultSessionKey(
  value: string,
  fallbackSessionKey: string,
): string {
  const trimmed = value.trim();
  const legacyMatch = /^agent:[^:]+:(.+)$/i.exec(trimmed);
  if (!legacyMatch) {
    return trimmed;
  }
  const routedSessionKey = legacyMatch[1]?.trim();
  if (typeof routedSessionKey === "string" && routedSessionKey.length > 0) {
    return routedSessionKey;
  }

  return fallbackSessionKey;
}

export function isCanonicalAgentSessionKey(value: string): boolean {
  return /^agent:[^:]+:.+/i.test(value.trim());
}

function generateOpenclawHookToken(): string {
  return randomBytes(OPENCLAW_HOOK_TOKEN_BYTES).toString("hex");
}

function generateOpenclawGatewayToken(): string {
  return randomBytes(OPENCLAW_HOOK_TOKEN_BYTES).toString("hex");
}

export function parseGatewayAuthMode(
  value: unknown,
): "token" | "password" | "trusted-proxy" | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "token" ||
    normalized === "password" ||
    normalized === "trusted-proxy"
  ) {
    return normalized;
  }
  return undefined;
}

function resolveEnvOpenclawGatewayToken(): string | undefined {
  if (
    typeof process.env.OPENCLAW_GATEWAY_TOKEN === "string" &&
    process.env.OPENCLAW_GATEWAY_TOKEN.trim().length > 0
  ) {
    return process.env.OPENCLAW_GATEWAY_TOKEN.trim();
  }
  return undefined;
}

function resolveGatewayAuthToken(existingToken?: string): string {
  return (
    resolveEnvOpenclawGatewayToken() ??
    existingToken ??
    generateOpenclawGatewayToken()
  );
}

function upsertRelayHookMapping(
  mappingsValue: unknown,
): Record<string, unknown>[] {
  const mappings = Array.isArray(mappingsValue)
    ? mappingsValue.filter(isRecord).map((mapping) => ({ ...mapping }))
    : [];

  const existingIndex = mappings.findIndex((mapping) => {
    if (mapping.id === HOOK_MAPPING_ID) {
      return true;
    }

    if (!isRecord(mapping.match)) {
      return false;
    }

    return mapping.match.path === HOOK_PATH_SEND_TO_PEER;
  });

  const baseMapping =
    existingIndex >= 0 && isRecord(mappings[existingIndex])
      ? mappings[existingIndex]
      : {};

  const nextMatch = isRecord(baseMapping.match) ? { ...baseMapping.match } : {};
  nextMatch.path = HOOK_PATH_SEND_TO_PEER;

  const nextTransform = isRecord(baseMapping.transform)
    ? { ...baseMapping.transform }
    : {};
  nextTransform.module = RELAY_MODULE_FILE_NAME;

  const relayMapping: Record<string, unknown> = {
    ...baseMapping,
    id: HOOK_MAPPING_ID,
    match: nextMatch,
    action: "agent",
    wakeMode: "now",
    transform: nextTransform,
  };

  if (existingIndex >= 0) {
    mappings[existingIndex] = relayMapping;
    return mappings;
  }

  mappings.push(relayMapping);
  return mappings;
}

export async function patchOpenclawConfig(
  openclawConfigPath: string,
  hookToken?: string,
): Promise<{ hookToken: string; configChanged: boolean }> {
  let config: unknown;
  try {
    config = await readJsonFile(openclawConfigPath);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      throw createCliError(
        "CLI_OPENCLAW_CONFIG_NOT_FOUND",
        "OpenClaw config file was not found",
        { openclawConfigPath },
      );
    }

    throw error;
  }

  if (!isRecord(config)) {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_CONFIG",
      "OpenClaw config root must be an object",
      { openclawConfigPath },
    );
  }

  const hooks = isRecord(config.hooks) ? { ...config.hooks } : {};
  const existingHookToken =
    typeof hooks.token === "string" && hooks.token.trim().length > 0
      ? hooks.token.trim()
      : undefined;
  const preferredHookToken =
    typeof hookToken === "string" && hookToken.trim().length > 0
      ? hookToken.trim()
      : undefined;
  const resolvedHookToken =
    existingHookToken ?? preferredHookToken ?? generateOpenclawHookToken();
  const defaultSessionKey = resolveHookDefaultSessionKey(config, hooks);

  hooks.enabled = true;
  hooks.token = resolvedHookToken;
  hooks.defaultSessionKey = defaultSessionKey;
  hooks.allowRequestSessionKey = false;
  hooks.allowedSessionKeyPrefixes = normalizeStringArrayWithValues(
    hooks.allowedSessionKeyPrefixes,
    ["hook:", defaultSessionKey],
  );
  hooks.mappings = upsertRelayHookMapping(hooks.mappings);

  const gateway = isRecord(config.gateway) ? { ...config.gateway } : {};
  const gatewayAuth = isRecord(gateway.auth) ? { ...gateway.auth } : {};
  const configuredGatewayAuthMode = parseGatewayAuthMode(gatewayAuth.mode);
  if (configuredGatewayAuthMode === undefined) {
    gatewayAuth.mode = "token";
  }

  const effectiveGatewayAuthMode =
    parseGatewayAuthMode(gatewayAuth.mode) ?? "token";
  if (effectiveGatewayAuthMode === "token") {
    const existingGatewayAuthToken =
      typeof gatewayAuth.token === "string" &&
      gatewayAuth.token.trim().length > 0
        ? gatewayAuth.token.trim()
        : undefined;
    gatewayAuth.token = resolveGatewayAuthToken(existingGatewayAuthToken);
  }
  gateway.auth = gatewayAuth;

  const nextConfig = {
    ...config,
    hooks,
    gateway,
  };
  const configChanged = JSON.stringify(config) !== JSON.stringify(nextConfig);
  if (configChanged) {
    await writeFile(
      openclawConfigPath,
      `${JSON.stringify(nextConfig, null, 2)}\n`,
      "utf8",
    );
  }

  return {
    hookToken: resolvedHookToken,
    configChanged,
  };
}

export function isRelayHookMapping(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  if (!isRecord(value.match) || value.match.path !== HOOK_PATH_SEND_TO_PEER) {
    return false;
  }

  if (typeof value.id === "string" && value.id !== HOOK_MAPPING_ID) {
    return false;
  }

  return true;
}

export function hasRelayTransformModule(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.transform)) {
    return false;
  }

  return value.transform.module === RELAY_MODULE_FILE_NAME;
}
