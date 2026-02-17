// src/transforms/peers-config.ts
import { chmod, mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
var CLAWDENTITY_DIR = ".clawdentity";
var PEERS_FILENAME = "peers.json";
var PEER_ALIAS_PATTERN = /^[a-zA-Z0-9._-]+$/;
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function getErrorCode(error) {
  if (!isRecord(error)) {
    return void 0;
  }
  return typeof error.code === "string" ? error.code : void 0;
}
function parseNonEmptyString(value, label) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  return trimmed;
}
function parsePeerAlias(value) {
  const alias = parseNonEmptyString(value, "peer alias");
  if (alias.length > 128) {
    throw new Error("peer alias must be at most 128 characters");
  }
  if (!PEER_ALIAS_PATTERN.test(alias)) {
    throw new Error(
      "peer alias must use only letters, numbers, dot, underscore, or hyphen"
    );
  }
  return alias;
}
function parseDid(value) {
  const did = parseNonEmptyString(value, "did");
  if (!did.startsWith("did:")) {
    throw new Error("did must start with 'did:'");
  }
  return did;
}
function parseProxyUrl(value) {
  const candidate = parseNonEmptyString(value, "proxyUrl");
  try {
    return new URL(candidate).toString();
  } catch {
    throw new Error("proxyUrl must be a valid URL");
  }
}
function parsePeerName(value) {
  if (value === void 0) {
    return void 0;
  }
  return parseNonEmptyString(value, "name");
}
function parsePeerEntry(value) {
  if (!isRecord(value)) {
    throw new Error("peer entry must be an object");
  }
  const did = parseDid(value.did);
  const proxyUrl = parseProxyUrl(value.proxyUrl);
  const name = parsePeerName(value.name);
  if (name === void 0) {
    return { did, proxyUrl };
  }
  return { did, proxyUrl, name };
}
function parsePeersConfig(value, source) {
  if (!isRecord(value)) {
    throw new Error(
      `Peer config validation failed at ${source}: root must be an object`
    );
  }
  const peersRaw = value.peers;
  if (peersRaw === void 0) {
    return { peers: {} };
  }
  if (!isRecord(peersRaw)) {
    throw new Error(
      `Peer config validation failed at ${source}: peers must be an object`
    );
  }
  const peers = {};
  for (const [alias, peerValue] of Object.entries(peersRaw)) {
    const normalizedAlias = parsePeerAlias(alias);
    try {
      peers[normalizedAlias] = parsePeerEntry(peerValue);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Peer config validation failed at ${source}: peers.${normalizedAlias}: ${reason}`
      );
    }
  }
  return { peers };
}
function resolvePeersConfigPath(options = {}) {
  if (typeof options.configPath === "string" && options.configPath.trim().length > 0) {
    return options.configPath.trim();
  }
  if (typeof options.configDir === "string" && options.configDir.trim().length > 0) {
    return join(options.configDir.trim(), PEERS_FILENAME);
  }
  const home = typeof options.homeDir === "string" && options.homeDir.trim().length > 0 ? options.homeDir.trim() : homedir();
  return join(home, CLAWDENTITY_DIR, PEERS_FILENAME);
}
async function loadPeersConfig(options = {}) {
  const configPath = resolvePeersConfigPath(options);
  let rawJson;
  try {
    rawJson = await readFile(configPath, "utf8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return { peers: {} };
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error(`Peer config at ${configPath} is not valid JSON`);
  }
  return parsePeersConfig(parsed, configPath);
}

// src/transforms/relay-to-peer.ts
var DEFAULT_CONNECTOR_BASE_URL = "http://127.0.0.1:19400";
var DEFAULT_CONNECTOR_OUTBOUND_PATH = "/v1/outbound";
function isRecord2(value) {
  return typeof value === "object" && value !== null;
}
function parseRequiredString(value) {
  if (typeof value !== "string") {
    throw new Error("Input value must be a string");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("Input value must not be empty");
  }
  return trimmed;
}
function removePeerField(payload) {
  const outbound = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key !== "peer") {
      outbound[key] = value;
    }
  }
  return outbound;
}
function resolveRelayFetch(fetchImpl) {
  const resolved = fetchImpl ?? globalThis.fetch;
  if (typeof resolved !== "function") {
    throw new Error("fetch implementation is required");
  }
  return resolved;
}
function parseConnectorBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Connector base URL is invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Connector base URL is invalid");
  }
  if (parsed.pathname === "/" && parsed.search.length === 0 && parsed.hash.length === 0) {
    return parsed.origin;
  }
  return parsed.toString();
}
function normalizeConnectorPath(value) {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("Connector outbound path is invalid");
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}
function resolveConnectorEndpoint(options) {
  const baseUrlInput = options.connectorBaseUrl ?? process.env.CLAWDENTITY_CONNECTOR_BASE_URL ?? DEFAULT_CONNECTOR_BASE_URL;
  const pathInput = options.connectorPath ?? process.env.CLAWDENTITY_CONNECTOR_OUTBOUND_PATH ?? DEFAULT_CONNECTOR_OUTBOUND_PATH;
  const baseUrl = parseConnectorBaseUrl(baseUrlInput.trim());
  const path = normalizeConnectorPath(pathInput.trim());
  return new URL(path, baseUrl).toString();
}
function mapConnectorFailure(status) {
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
async function postToConnector(endpoint, payload, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
  } catch {
    throw new Error("Local connector outbound relay request failed");
  }
  if (!response.ok) {
    throw mapConnectorFailure(response.status);
  }
}
async function relayPayloadToPeer(payload, options = {}) {
  if (!isRecord2(payload)) {
    return payload;
  }
  const peerAliasValue = payload.peer;
  if (peerAliasValue === void 0) {
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
      payload: outboundPayload
    },
    fetchImpl
  );
  return null;
}
async function relayToPeer(ctx) {
  return relayPayloadToPeer(ctx?.payload);
}
export {
  relayToPeer as default,
  relayPayloadToPeer
};
