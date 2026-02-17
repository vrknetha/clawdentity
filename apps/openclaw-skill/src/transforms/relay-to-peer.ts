import {
  loadPeersConfig,
  type PeersConfigPathOptions,
} from "./peers-config.js";

const DEFAULT_CONNECTOR_BASE_URL = "http://127.0.0.1:19400";
const DEFAULT_CONNECTOR_OUTBOUND_PATH = "/v1/outbound";

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

function resolveConnectorEndpoint(options: RelayToPeerOptions): string {
  const baseUrlInput =
    options.connectorBaseUrl ??
    process.env.CLAWDENTITY_CONNECTOR_BASE_URL ??
    DEFAULT_CONNECTOR_BASE_URL;
  const pathInput =
    options.connectorPath ??
    process.env.CLAWDENTITY_CONNECTOR_OUTBOUND_PATH ??
    DEFAULT_CONNECTOR_OUTBOUND_PATH;

  const baseUrl = parseConnectorBaseUrl(baseUrlInput.trim());
  const path = normalizeConnectorPath(pathInput.trim());

  return new URL(path, baseUrl).toString();
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
  const peersConfig = await loadPeersConfig(options);
  const peerEntry = peersConfig.peers[peerAlias];

  if (!peerEntry) {
    throw new Error("Peer alias is not configured");
  }

  const connectorEndpoint = resolveConnectorEndpoint(options);
  const fetchImpl = resolveRelayFetch(options.fetchImpl);
  const outboundPayload = removePeerField(payload);
  await postToConnector(
    connectorEndpoint,
    {
      peer: peerAlias,
      peerDid: peerEntry.did,
      peerProxyUrl: peerEntry.proxyUrl,
      payload: outboundPayload,
    },
    fetchImpl,
  );

  return null;
}

export default async function relayToPeer(
  ctx: RelayTransformContext,
): Promise<unknown | null> {
  return relayPayloadToPeer(ctx?.payload);
}
