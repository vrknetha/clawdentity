import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadPeersConfig,
  type PeersConfigPathOptions,
} from "./peers-config.js";

const DEFAULT_CONNECTOR_BASE_URL = "http://127.0.0.1:19400";
const DEFAULT_CONNECTOR_OUTBOUND_PATH = "/v1/outbound";
const RELAY_RUNTIME_FILE_NAME = "clawdentity-relay.json";
const RELAY_PEERS_FILE_NAME = "clawdentity-peers.json";

type RelayRuntimeConfig = {
  connectorBaseUrl?: string;
  connectorBaseUrls?: string[];
  connectorPath?: string;
  peersConfigPath?: string;
};

export type RelayToPeerOptions = PeersConfigPathOptions & {
  connectorBaseUrl?: string;
  connectorPath?: string;
  fetchImpl?: typeof fetch;
};

export type RelayTransformContext = {
  payload?: unknown;
};

type ConnectorRelayRequest = {
  payload: Record<string, unknown>;
  peer: string;
  peerDid: string;
  peerProxyUrl: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  return typeof error.code === "string" ? error.code : undefined;
}

function parseRequiredString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Input value must be a string");
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("Input value must not be empty");
  }

  return trimmed;
}

function removePeerField(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const outbound: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(payload)) {
    if (key !== "peer") {
      outbound[key] = value;
    }
  }

  return outbound;
}

function resolveRelayFetch(fetchImpl?: typeof fetch): typeof fetch {
  const resolved = fetchImpl ?? globalThis.fetch;
  if (typeof resolved !== "function") {
    throw new Error("fetch implementation is required");
  }

  return resolved;
}

function parseConnectorBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Connector base URL is invalid");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Connector base URL is invalid");
  }

  if (
    parsed.pathname === "/" &&
    parsed.search.length === 0 &&
    parsed.hash.length === 0
  ) {
    return parsed.origin;
  }

  return parsed.toString();
}

function normalizeConnectorPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("Connector outbound path is invalid");
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function resolveTransformsDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

async function readJson(filePath: string): Promise<unknown | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return undefined;
    }

    throw error;
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Relay runtime config at ${filePath} is not valid JSON`);
  }
}

function parseRelayRuntimeConfig(value: unknown): RelayRuntimeConfig {
  if (!isRecord(value)) {
    throw new Error("Relay runtime config must be an object");
  }

  const connectorBaseUrl =
    typeof value.connectorBaseUrl === "string" &&
    value.connectorBaseUrl.trim().length > 0
      ? parseConnectorBaseUrl(value.connectorBaseUrl.trim())
      : undefined;
  const connectorPath =
    typeof value.connectorPath === "string" &&
    value.connectorPath.trim().length > 0
      ? normalizeConnectorPath(value.connectorPath)
      : undefined;
  const peersConfigPath =
    typeof value.peersConfigPath === "string" &&
    value.peersConfigPath.trim().length > 0
      ? value.peersConfigPath.trim()
      : undefined;

  const connectorBaseUrls = Array.isArray(value.connectorBaseUrls)
    ? value.connectorBaseUrls
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .map(parseConnectorBaseUrl)
    : undefined;

  return {
    connectorBaseUrl,
    connectorBaseUrls,
    connectorPath,
    peersConfigPath,
  };
}

async function loadRelayRuntimeConfig(): Promise<RelayRuntimeConfig> {
  const runtimePath = join(resolveTransformsDir(), RELAY_RUNTIME_FILE_NAME);
  const parsed = await readJson(runtimePath);
  if (parsed === undefined) {
    return {};
  }

  return parseRelayRuntimeConfig(parsed);
}

function parseGatewayHexToIpv4(value: string): string | undefined {
  if (!/^[0-9A-Fa-f]{8}$/.test(value)) {
    return undefined;
  }

  const octets = [0, 2, 4, 6].map((index) =>
    Number.parseInt(value.slice(index, index + 2), 16),
  );
  return `${octets[3]}.${octets[2]}.${octets[1]}.${octets[0]}`;
}

async function resolveLinuxDockerGatewayHost(): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile("/proc/net/route", "utf8");
  } catch {
    return undefined;
  }

  const lines = raw.split("\n");
  for (const line of lines.slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) {
      continue;
    }
    const destination = parts[1];
    const gateway = parts[2];
    const flags = Number.parseInt(parts[3], 16);
    if (
      destination === "00000000" &&
      Number.isFinite(flags) &&
      (flags & 0x2) === 0x2
    ) {
      return parseGatewayHexToIpv4(gateway);
    }
  }

  return undefined;
}

async function resolveConnectorEndpoints(
  options: RelayToPeerOptions,
): Promise<string[]> {
  const runtimeConfig = await loadRelayRuntimeConfig();
  const pathInput =
    options.connectorPath ??
    runtimeConfig.connectorPath ??
    process.env.CLAWDENTITY_CONNECTOR_OUTBOUND_PATH ??
    DEFAULT_CONNECTOR_OUTBOUND_PATH;
  const path = normalizeConnectorPath(pathInput.trim());

  const candidates: string[] = [];
  if (options.connectorBaseUrl) {
    candidates.push(parseConnectorBaseUrl(options.connectorBaseUrl.trim()));
  }
  if (runtimeConfig.connectorBaseUrls) {
    candidates.push(...runtimeConfig.connectorBaseUrls);
  }
  if (runtimeConfig.connectorBaseUrl) {
    candidates.push(runtimeConfig.connectorBaseUrl);
  }
  if (
    typeof process.env.CLAWDENTITY_CONNECTOR_BASE_URL === "string" &&
    process.env.CLAWDENTITY_CONNECTOR_BASE_URL.trim().length > 0
  ) {
    candidates.push(
      parseConnectorBaseUrl(process.env.CLAWDENTITY_CONNECTOR_BASE_URL.trim()),
    );
  }
  candidates.push(DEFAULT_CONNECTOR_BASE_URL);

  const linuxGatewayHost = await resolveLinuxDockerGatewayHost();
  if (linuxGatewayHost) {
    for (const candidate of [...candidates]) {
      try {
        const parsed = new URL(candidate);
        if (
          parsed.hostname === "host.docker.internal" ||
          parsed.hostname === "gateway.docker.internal" ||
          parsed.hostname === "172.17.0.1"
        ) {
          parsed.hostname = linuxGatewayHost;
          candidates.push(parsed.toString());
        }
      } catch {
        // Ignore malformed candidate; parseConnectorBaseUrl already guards known values.
      }
    }
  }

  const deduped = Array.from(new Set(candidates.map((candidate) => candidate)));
  return deduped.map((baseUrl) => new URL(path, baseUrl).toString());
}

function mapConnectorFailure(status: number): Error {
  if (status === 404) {
    return new Error("Local connector outbound endpoint is unavailable");
  }

  if (status === 409) {
    return new Error("Peer alias is not configured");
  }

  if (status === 400 || status === 422) {
    return new Error("Local connector rejected outbound relay payload");
  }

  return new Error("Local connector outbound relay request failed");
}

async function postToConnector(
  endpoint: string,
  payload: ConnectorRelayRequest,
  fetchImpl: typeof fetch,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error("Local connector outbound relay request failed");
  }

  if (!response.ok) {
    throw mapConnectorFailure(response.status);
  }
}

function shouldTryNextConnectorEndpoint(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message === "Local connector outbound relay request failed" ||
    error.message === "Local connector outbound endpoint is unavailable"
  );
}

async function resolvePeersConfigPathOptions(
  options: RelayToPeerOptions,
): Promise<PeersConfigPathOptions> {
  if (
    options.configPath !== undefined ||
    options.configDir !== undefined ||
    options.homeDir !== undefined
  ) {
    return options;
  }

  const runtimeConfig = await loadRelayRuntimeConfig();
  if (runtimeConfig.peersConfigPath) {
    return {
      configPath: join(resolveTransformsDir(), runtimeConfig.peersConfigPath),
    };
  }

  return {
    configPath: join(resolveTransformsDir(), RELAY_PEERS_FILE_NAME),
  };
}

export async function relayPayloadToPeer(
  payload: unknown,
  options: RelayToPeerOptions = {},
): Promise<unknown | null> {
  if (!isRecord(payload)) {
    return payload;
  }

  const peerAliasValue = payload.peer;
  if (peerAliasValue === undefined) {
    return payload;
  }

  const peerAlias = parseRequiredString(peerAliasValue);
  const peersConfigPathOptions = await resolvePeersConfigPathOptions(options);
  const peersConfig = await loadPeersConfig(peersConfigPathOptions);
  const peerEntry = peersConfig.peers[peerAlias];

  if (!peerEntry) {
    throw new Error("Peer alias is not configured");
  }

  const connectorEndpoints = await resolveConnectorEndpoints(options);
  const fetchImpl = resolveRelayFetch(options.fetchImpl);
  const outboundPayload = removePeerField(payload);
  const relayPayload: ConnectorRelayRequest = {
    peer: peerAlias,
    peerDid: peerEntry.did,
    peerProxyUrl: peerEntry.proxyUrl,
    payload: outboundPayload,
  };

  let lastError: unknown;
  for (const endpoint of connectorEndpoints) {
    try {
      await postToConnector(endpoint, relayPayload, fetchImpl);
      return null;
    } catch (error) {
      lastError = error;
      if (!shouldTryNextConnectorEndpoint(error)) {
        throw error;
      }
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new Error("Local connector outbound relay request failed");
}

export default async function relayToPeer(
  ctx: RelayTransformContext,
): Promise<unknown | null> {
  return relayPayloadToPeer(ctx?.payload);
}
