import { join } from "node:path";
import { fetchRegistryMetadata } from "../../config/registry-metadata.js";
import {
  DEFAULT_CONNECTOR_OUTBOUND_PATH,
  OPENCLAW_CONNECTORS_FILE_NAME,
  OPENCLAW_RELAY_RUNTIME_FILE_NAME,
  type OpenclawRelayRuntimeConfig,
  type ReadFileText,
} from "./types.js";
import {
  createCliError,
  getErrorCode,
  isRecord,
  normalizeOutboundPath,
  parseConnectorBaseUrl,
  parseProxyWebsocketUrl,
} from "./validation.js";

export function resolveProxyWebsocketUrlFromEnv(): string | undefined {
  const explicitProxyWsUrl = process.env.CLAWDENTITY_PROXY_WS_URL;
  if (
    typeof explicitProxyWsUrl === "string" &&
    explicitProxyWsUrl.trim().length > 0
  ) {
    return parseProxyWebsocketUrl(explicitProxyWsUrl.trim());
  }

  const proxyUrl = process.env.CLAWDENTITY_PROXY_URL;
  if (typeof proxyUrl === "string" && proxyUrl.trim().length > 0) {
    return parseProxyWebsocketUrl(proxyUrl.trim());
  }

  return undefined;
}

export async function resolveProxyWebsocketUrl(input: {
  explicitProxyWsUrl?: string;
  configProxyUrl?: string;
  registryUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  if (
    typeof input.explicitProxyWsUrl === "string" &&
    input.explicitProxyWsUrl.trim().length > 0
  ) {
    return parseProxyWebsocketUrl(input.explicitProxyWsUrl.trim());
  }

  const fromEnv = resolveProxyWebsocketUrlFromEnv();
  if (fromEnv !== undefined) {
    return fromEnv;
  }

  if (
    typeof input.configProxyUrl === "string" &&
    input.configProxyUrl.trim().length > 0
  ) {
    return parseProxyWebsocketUrl(input.configProxyUrl.trim());
  }

  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl === "function") {
    try {
      const metadata = await fetchRegistryMetadata(input.registryUrl, {
        fetchImpl,
      });
      return parseProxyWebsocketUrl(metadata.proxyUrl);
    } catch {
      // Fall through to deterministic operator guidance below.
    }
  }

  throw createCliError(
    "CLI_CONNECTOR_PROXY_URL_REQUIRED",
    "Proxy URL is required for connector startup. Run `clawdentity invite redeem <clw_inv_...>` or set CLAWDENTITY_PROXY_URL / CLAWDENTITY_PROXY_WS_URL.",
  );
}

export function resolveConnectorBaseUrlFromEnv(): string | undefined {
  const value = process.env.CLAWDENTITY_CONNECTOR_BASE_URL;
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  return parseConnectorBaseUrl(value.trim());
}

export async function readConnectorAssignedBaseUrl(
  configDir: string,
  agentName: string,
  readFileImpl: ReadFileText,
): Promise<string | undefined> {
  const assignmentsPath = join(configDir, OPENCLAW_CONNECTORS_FILE_NAME);
  let raw: string;
  try {
    raw = await readFileImpl(assignmentsPath, "utf8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw createCliError(
      "CLI_CONNECTOR_INVALID_ASSIGNMENTS",
      "Connector assignments config is invalid JSON",
      { assignmentsPath },
    );
  }

  if (!isRecord(parsed) || !isRecord(parsed.agents)) {
    return undefined;
  }

  const entry = parsed.agents[agentName];
  if (!isRecord(entry) || typeof entry.connectorBaseUrl !== "string") {
    return undefined;
  }

  return parseConnectorBaseUrl(entry.connectorBaseUrl);
}

export function resolveConnectorOutboundPath(): string {
  const value = process.env.CLAWDENTITY_CONNECTOR_OUTBOUND_PATH;
  if (typeof value !== "string" || value.trim().length === 0) {
    return DEFAULT_CONNECTOR_OUTBOUND_PATH;
  }

  return normalizeOutboundPath(value);
}

export function resolveOutboundUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrl).toString();
}

export async function readRelayRuntimeConfig(
  configDir: string,
  readFileImpl: ReadFileText,
): Promise<OpenclawRelayRuntimeConfig | undefined> {
  const filePath = join(configDir, OPENCLAW_RELAY_RUNTIME_FILE_NAME);
  let raw: string;
  try {
    raw = await readFileImpl(filePath, "utf8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (!isRecord(parsed)) {
    return undefined;
  }

  const openclawHookToken =
    typeof parsed.openclawHookToken === "string" &&
    parsed.openclawHookToken.trim().length > 0
      ? parsed.openclawHookToken.trim()
      : undefined;
  if (!openclawHookToken) {
    return undefined;
  }

  return {
    openclawHookToken,
  };
}
