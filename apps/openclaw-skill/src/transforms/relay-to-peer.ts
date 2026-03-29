import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "@clawdentity/common";
import { parseAgentDid as parseProtocolAgentDid } from "@clawdentity/protocol";
import {
  loadPeersConfig,
  type PeersConfigPathOptions,
} from "./peers-config.js";
import {
  readEndpointHealthCache,
  writeEndpointHealthCache,
} from "./relay-health-cache.js";

const DEFAULT_CONNECTOR_BASE_URL = "http://127.0.0.1:19400";
const DEFAULT_CONNECTOR_OUTBOUND_PATH = "/v1/outbound";
const DEFAULT_CONNECTOR_STATUS_PATH = "/v1/status";
const DEFAULT_CONNECTOR_HEALTH_CACHE_TTL_MS = 5_000;
const DEFAULT_CONNECTOR_HEALTH_TIMEOUT_MS = 1_500;
const DEFAULT_CONNECTOR_POST_TIMEOUT_MS = 10_000;
const RELAY_RUNTIME_FILE_NAME = "clawdentity-relay.json";
const RELAY_PEERS_FILE_NAME = "clawdentity-peers.json";

type RelayRuntimeConfig = {
  connectorBaseUrl?: string;
  connectorBaseUrls?: string[];
  connectorHealthCacheTtlMs?: number;
  connectorHealthTimeoutMs?: number;
  connectorPath?: string;
  connectorPostTimeoutMs?: number;
  connectorStatusPath?: string;
  localAgentDid?: string;
  peersConfigPath?: string;
};

export type RelayToPeerOptions = PeersConfigPathOptions & {
  connectorBaseUrl?: string;
  connectorHealthCacheTtlMs?: number;
  connectorHealthTimeoutMs?: number;
  connectorPath?: string;
  connectorPostTimeoutMs?: number;
  connectorStatusPath?: string;
  fetchImpl?: typeof fetch;
  runtimeConfigPath?: string;
};

export type RelayTransformContext = {
  payload?: unknown;
};

type ConnectorRelayRequest = {
  conversationId?: string;
  payload: Record<string, unknown>;
  toAgentDid: string;
};

type ConnectorEndpoint = {
  outboundUrl: string;
  statusUrl: string;
};

type RelayErrorCategory =
  | "connector_unavailable"
  | "connector_timeout"
  | "connector_queue_full"
  | "connector_request_rejected"
  | "connector_request_failed";

export class RelayTransformError extends Error {
  readonly category: RelayErrorCategory;
  readonly retryable: boolean;
  readonly statusCode?: number;

  constructor(input: {
    category: RelayErrorCategory;
    message: string;
    retryable: boolean;
    statusCode?: number;
  }) {
    super(input.message);
    this.name = "RelayTransformError";
    this.category = input.category;
    this.retryable = input.retryable;
    this.statusCode = input.statusCode;
  }
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

function parseOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseOptionalPositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      "Relay runtime config timeout values must be positive integers",
    );
  }

  return parsed;
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
    throw new Error("Connector path is invalid");
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
  const connectorStatusPath =
    typeof value.connectorStatusPath === "string" &&
    value.connectorStatusPath.trim().length > 0
      ? normalizeConnectorPath(value.connectorStatusPath)
      : undefined;
  const peersConfigPath =
    typeof value.peersConfigPath === "string" &&
    value.peersConfigPath.trim().length > 0
      ? value.peersConfigPath.trim()
      : undefined;
  const localAgentDid = parseOptionalString(value.localAgentDid);
  if (localAgentDid) {
    try {
      parseProtocolAgentDid(localAgentDid);
    } catch {
      throw new Error("Relay runtime config localAgentDid is invalid");
    }
  }

  const connectorBaseUrls = Array.isArray(value.connectorBaseUrls)
    ? value.connectorBaseUrls
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .map(parseConnectorBaseUrl)
    : undefined;

  const connectorHealthCacheTtlMs = parseOptionalPositiveInteger(
    value.connectorHealthCacheTtlMs,
  );
  const connectorHealthTimeoutMs = parseOptionalPositiveInteger(
    value.connectorHealthTimeoutMs,
  );
  const connectorPostTimeoutMs = parseOptionalPositiveInteger(
    value.connectorPostTimeoutMs,
  );

  return {
    connectorBaseUrl,
    connectorBaseUrls,
    connectorHealthCacheTtlMs,
    connectorHealthTimeoutMs,
    connectorPath,
    connectorPostTimeoutMs,
    connectorStatusPath,
    localAgentDid,
    peersConfigPath,
  };
}

function resolveRuntimeConfigPath(options: RelayToPeerOptions = {}): string {
  if (
    typeof options.runtimeConfigPath === "string" &&
    options.runtimeConfigPath.trim().length > 0
  ) {
    return options.runtimeConfigPath.trim();
  }

  return join(resolveTransformsDir(), RELAY_RUNTIME_FILE_NAME);
}

async function loadRelayRuntimeConfig(
  options: RelayToPeerOptions = {},
): Promise<RelayRuntimeConfig> {
  const runtimePath = resolveRuntimeConfigPath(options);
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
): Promise<ConnectorEndpoint[]> {
  const runtimeConfig = await loadRelayRuntimeConfig(options);
  const outboundPathInput =
    options.connectorPath ??
    runtimeConfig.connectorPath ??
    process.env.CLAWDENTITY_CONNECTOR_OUTBOUND_PATH ??
    DEFAULT_CONNECTOR_OUTBOUND_PATH;
  const outboundPath = normalizeConnectorPath(outboundPathInput.trim());

  const statusPathInput =
    options.connectorStatusPath ??
    runtimeConfig.connectorStatusPath ??
    process.env.CLAWDENTITY_CONNECTOR_STATUS_PATH ??
    DEFAULT_CONNECTOR_STATUS_PATH;
  const statusPath = normalizeConnectorPath(statusPathInput.trim());

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
  return deduped.map((baseUrl) => ({
    outboundUrl: new URL(outboundPath, baseUrl).toString(),
    statusUrl: new URL(statusPath, baseUrl).toString(),
  }));
}

function mapConnectorFailure(input: {
  connectorMessage?: string;
  status: number;
}): RelayTransformError {
  const status = input.status;

  if (status === 404) {
    return new RelayTransformError({
      category: "connector_unavailable",
      message: "Local connector outbound endpoint is unavailable",
      retryable: true,
      statusCode: status,
    });
  }

  if (status === 400 || status === 422) {
    return new RelayTransformError({
      category: "connector_request_rejected",
      message:
        input.connectorMessage ??
        "Local connector rejected outbound relay payload",
      retryable: false,
      statusCode: status,
    });
  }

  if (status === 507) {
    return new RelayTransformError({
      category: "connector_queue_full",
      message:
        input.connectorMessage ?? "Local connector outbound queue is full",
      retryable: true,
      statusCode: status,
    });
  }

  return new RelayTransformError({
    category: "connector_request_failed",
    message:
      input.connectorMessage ?? "Local connector outbound relay request failed",
    retryable: status >= 500,
    statusCode: status,
  });
}

function isTimeoutLike(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }

  return error.name === "TimeoutError" || error.name === "AbortError";
}

function normalizeRelayError(error: unknown): RelayTransformError {
  if (error instanceof RelayTransformError) {
    return error;
  }

  if (isTimeoutLike(error)) {
    return new RelayTransformError({
      category: "connector_timeout",
      message: "Local connector outbound relay request timed out",
      retryable: true,
    });
  }

  return new RelayTransformError({
    category: "connector_unavailable",
    message: "Local connector outbound relay request failed",
    retryable: true,
  });
}

async function parseConnectorErrorMessage(
  response: Response,
): Promise<string | undefined> {
  try {
    const payload: unknown = await response.json();
    if (!isRecord(payload)) {
      return undefined;
    }

    const errorPayload = payload.error;
    if (!isRecord(errorPayload)) {
      return undefined;
    }

    return typeof errorPayload.message === "string"
      ? errorPayload.message
      : undefined;
  } catch {
    return undefined;
  }
}

function computeHealthCacheTtlMs(
  options: RelayToPeerOptions,
  runtimeConfig: RelayRuntimeConfig,
): number {
  return (
    options.connectorHealthCacheTtlMs ??
    runtimeConfig.connectorHealthCacheTtlMs ??
    parseOptionalPositiveInteger(
      process.env.CLAWDENTITY_CONNECTOR_HEALTH_CACHE_TTL_MS,
    ) ??
    DEFAULT_CONNECTOR_HEALTH_CACHE_TTL_MS
  );
}

function computeHealthTimeoutMs(
  options: RelayToPeerOptions,
  runtimeConfig: RelayRuntimeConfig,
): number {
  return (
    options.connectorHealthTimeoutMs ??
    runtimeConfig.connectorHealthTimeoutMs ??
    parseOptionalPositiveInteger(
      process.env.CLAWDENTITY_CONNECTOR_HEALTH_TIMEOUT_MS,
    ) ??
    DEFAULT_CONNECTOR_HEALTH_TIMEOUT_MS
  );
}

function computePostTimeoutMs(
  options: RelayToPeerOptions,
  runtimeConfig: RelayRuntimeConfig,
): number {
  return (
    options.connectorPostTimeoutMs ??
    runtimeConfig.connectorPostTimeoutMs ??
    parseOptionalPositiveInteger(
      process.env.CLAWDENTITY_CONNECTOR_POST_TIMEOUT_MS,
    ) ??
    DEFAULT_CONNECTOR_POST_TIMEOUT_MS
  );
}

async function isEndpointHealthy(input: {
  endpoint: ConnectorEndpoint;
  fetchImpl: typeof fetch;
  healthCacheTtlMs: number;
  healthTimeoutMs: number;
}): Promise<boolean> {
  const nowMs = Date.now();
  const cached = readEndpointHealthCache({
    statusUrl: input.endpoint.statusUrl,
    nowMs,
    healthCacheTtlMs: input.healthCacheTtlMs,
  });
  if (cached !== undefined) {
    return cached;
  }

  let healthy = false;
  try {
    const response = await input.fetchImpl(input.endpoint.statusUrl, {
      method: "GET",
      signal: AbortSignal.timeout(input.healthTimeoutMs),
    });
    healthy = response.ok;
  } catch {
    healthy = false;
  }

  writeEndpointHealthCache({
    statusUrl: input.endpoint.statusUrl,
    checkedAtMs: nowMs,
    healthCacheTtlMs: input.healthCacheTtlMs,
    healthy,
  });

  return healthy;
}

async function postToConnector(input: {
  endpoint: ConnectorEndpoint;
  fetchImpl: typeof fetch;
  payload: ConnectorRelayRequest;
  timeoutMs: number;
}): Promise<void> {
  let response: Response;
  try {
    response = await input.fetchImpl(input.endpoint.outboundUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input.payload),
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch (error) {
    throw normalizeRelayError(error);
  }

  if (!response.ok) {
    const connectorMessage = await parseConnectorErrorMessage(response);
    throw mapConnectorFailure({
      connectorMessage,
      status: response.status,
    });
  }
}

function shouldTryNextConnectorEndpoint(error: unknown): boolean {
  const normalized = normalizeRelayError(error);
  return normalized.retryable;
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

  const runtimeConfig = await loadRelayRuntimeConfig(options);
  if (runtimeConfig.peersConfigPath) {
    return {
      configPath: isAbsolute(runtimeConfig.peersConfigPath)
        ? runtimeConfig.peersConfigPath
        : join(resolveTransformsDir(), runtimeConfig.peersConfigPath),
    };
  }

  return {
    configPath: join(resolveTransformsDir(), RELAY_PEERS_FILE_NAME),
  };
}

async function readLocalAgentDidFromRuntime(
  options: RelayToPeerOptions,
): Promise<string | undefined> {
  const runtimeConfig = await loadRelayRuntimeConfig(options);
  return runtimeConfig.localAgentDid;
}

function buildDeterministicConversationId(
  localAgentDid: string,
  peerDid: string,
): string {
  const seed = [localAgentDid, peerDid].sort().join("\n");
  const digest = createHash("sha256").update(seed, "utf8").digest("hex");
  return `pair:${digest}`;
}

async function resolveRelayConversationId(input: {
  options: RelayToPeerOptions;
  payload: Record<string, unknown>;
  peerDid: string;
}): Promise<string> {
  const explicitConversationId = parseOptionalString(
    input.payload.conversationId,
  );
  if (explicitConversationId) {
    return explicitConversationId;
  }

  const localAgentDid = await readLocalAgentDidFromRuntime(input.options);
  if (!localAgentDid) {
    throw new Error(
      "OpenClaw relay runtime is missing localAgentDid. Re-run `clawdentity provider setup --for openclaw --agent-name <agent-name>`.",
    );
  }

  return buildDeterministicConversationId(localAgentDid, input.peerDid);
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
  const conversationId = await resolveRelayConversationId({
    options,
    payload,
    peerDid: peerEntry.did,
  });
  const relayPayload: ConnectorRelayRequest = {
    conversationId,
    toAgentDid: peerEntry.did,
    payload: outboundPayload,
  };

  const runtimeConfig = await loadRelayRuntimeConfig(options);
  const healthCacheTtlMs = computeHealthCacheTtlMs(options, runtimeConfig);
  const healthTimeoutMs = computeHealthTimeoutMs(options, runtimeConfig);
  const postTimeoutMs = computePostTimeoutMs(options, runtimeConfig);

  const healthyEndpoints: ConnectorEndpoint[] = [];
  for (const endpoint of connectorEndpoints) {
    if (
      await isEndpointHealthy({
        endpoint,
        fetchImpl,
        healthCacheTtlMs,
        healthTimeoutMs,
      })
    ) {
      healthyEndpoints.push(endpoint);
    }
  }

  if (healthyEndpoints.length === 0) {
    throw new RelayTransformError({
      category: "connector_unavailable",
      message: "Local connector status endpoint is unavailable",
      retryable: true,
    });
  }

  let lastError: unknown;
  for (const endpoint of healthyEndpoints) {
    try {
      await postToConnector({
        endpoint,
        fetchImpl,
        payload: relayPayload,
        timeoutMs: postTimeoutMs,
      });
      writeEndpointHealthCache({
        statusUrl: endpoint.statusUrl,
        checkedAtMs: Date.now(),
        healthCacheTtlMs,
        healthy: true,
      });
      return null;
    } catch (error) {
      lastError = error;
      const normalizedError = normalizeRelayError(error);
      const shouldMarkEndpointUnhealthy =
        normalizedError.category === "connector_unavailable" ||
        normalizedError.category === "connector_timeout";
      writeEndpointHealthCache({
        statusUrl: endpoint.statusUrl,
        checkedAtMs: Date.now(),
        healthCacheTtlMs,
        healthy: !shouldMarkEndpointUnhealthy,
      });
      if (!shouldTryNextConnectorEndpoint(error)) {
        throw normalizedError;
      }
    }
  }

  if (lastError !== undefined) {
    throw normalizeRelayError(lastError);
  }

  throw new RelayTransformError({
    category: "connector_request_failed",
    message: "Local connector outbound relay request failed",
    retryable: true,
  });
}

export default async function relayToPeer(
  ctx: RelayTransformContext,
): Promise<unknown | null> {
  return relayPayloadToPeer(ctx?.payload);
}
