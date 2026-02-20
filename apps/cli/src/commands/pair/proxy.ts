import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeBase64url } from "@clawdentity/protocol";
import { signHttpRequest } from "@clawdentity/sdk";
import {
  type CliConfig,
  getConfigDir,
  resolveConfig,
} from "../../config/manager.js";
import { fetchRegistryMetadata } from "../../config/registry-metadata.js";
import { assertValidAgentName } from "../agent-name.js";
import {
  AGENTS_DIR_NAME,
  AIT_FILE_NAME,
  createCliError,
  isRecord,
  parseNonEmptyString,
  parsePairingTicket,
  parsePairingTicketIssuerOrigin,
  parsePeerProfile,
  parseProxyUrl,
  SECRET_KEY_FILE_NAME,
  toPathWithQuery,
} from "./common.js";
import type {
  LocalAgentProofMaterial,
  PairConfirmResult,
  PairRequestOptions,
  PairStartResult,
  PairStatusResult,
  RegistryErrorEnvelope,
} from "./types.js";

export async function resolveProxyUrl(input: {
  config: CliConfig;
  fetchImpl: typeof fetch;
}): Promise<string> {
  const fromEnv = parseNonEmptyString(process.env.CLAWDENTITY_PROXY_URL);
  if (fromEnv.length > 0) {
    return parseProxyUrl(fromEnv);
  }

  const metadata = await fetchRegistryMetadata(input.config.registryUrl, {
    fetchImpl: input.fetchImpl,
  });
  const metadataProxyUrl = parseProxyUrl(metadata.proxyUrl);

  const configuredProxyUrl = parseNonEmptyString(input.config.proxyUrl);
  if (configuredProxyUrl.length === 0) {
    return metadataProxyUrl;
  }

  const normalizedConfiguredProxyUrl = parseProxyUrl(configuredProxyUrl);
  if (normalizedConfiguredProxyUrl === metadataProxyUrl) {
    return metadataProxyUrl;
  }

  throw createCliError(
    "CLI_PAIR_PROXY_URL_MISMATCH",
    `Configured proxy URL does not match registry metadata. config=${normalizedConfiguredProxyUrl} metadata=${metadataProxyUrl}. Rerun onboarding invite redeem to refresh config.`,
  );
}

export function toProxyRequestUrl(proxyUrl: string, path: string): string {
  const normalizedBase = proxyUrl.endsWith("/") ? proxyUrl : `${proxyUrl}/`;
  return new URL(path.slice(1), normalizedBase).toString();
}

export function toIssuerProxyUrl(ticket: string): string {
  return parseProxyUrl(parsePairingTicketIssuerOrigin(ticket));
}

export function toIssuerProxyRequestUrl(ticket: string, path: string): string {
  return toProxyRequestUrl(toIssuerProxyUrl(ticket), path);
}

function extractErrorCode(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  const envelope = payload as RegistryErrorEnvelope;
  if (!envelope.error || typeof envelope.error.code !== "string") {
    return undefined;
  }

  const code = envelope.error.code.trim();
  return code.length > 0 ? code : undefined;
}

function extractErrorMessage(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  const envelope = payload as RegistryErrorEnvelope;
  if (!envelope.error || typeof envelope.error.message !== "string") {
    return undefined;
  }

  const message = envelope.error.message.trim();
  return message.length > 0 ? message : undefined;
}

export async function parseJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export async function executePairRequest(input: {
  fetchImpl: typeof fetch;
  init: RequestInit;
  url: string;
}): Promise<Response> {
  try {
    return await input.fetchImpl(input.url, input.init);
  } catch {
    throw createCliError(
      "CLI_PAIR_REQUEST_FAILED",
      "Unable to connect to proxy URL. Check network access and proxyUrl.",
    );
  }
}

export function mapStartPairError(status: number, payload: unknown): string {
  const code = extractErrorCode(payload);
  const message = extractErrorMessage(payload);

  if (code === "PROXY_PAIR_OWNERSHIP_FORBIDDEN" || status === 403) {
    return message
      ? `Initiator agent ownership check failed (403): ${message}`
      : "Initiator agent ownership check failed (403).";
  }

  if (status === 400) {
    return message
      ? `Pair start request is invalid (400): ${message}`
      : "Pair start request is invalid (400).";
  }

  if (status >= 500) {
    return `Proxy pairing service is unavailable (${status}).`;
  }

  if (message) {
    return `Pair start failed (${status}): ${message}`;
  }

  return `Pair start failed (${status})`;
}

export function mapConfirmPairError(status: number, payload: unknown): string {
  const code = extractErrorCode(payload);
  const message = extractErrorMessage(payload);

  if (code === "PROXY_PAIR_TICKET_NOT_FOUND" || status === 404) {
    return "Pairing ticket is invalid or expired";
  }

  if (code === "PROXY_PAIR_TICKET_EXPIRED" || status === 410) {
    return "Pairing ticket has expired";
  }

  if (code === "PROXY_PAIR_TICKET_INVALID_ISSUER") {
    return message
      ? `Pair confirm failed: ticket issuer does not match this proxy (${message}). Use the same proxy URL where the ticket was issued.`
      : "Pair confirm failed: ticket issuer does not match this proxy. Use the same proxy URL where the ticket was issued.";
  }

  if (
    code === "PROXY_PAIR_TICKET_INVALID_FORMAT" ||
    code === "PROXY_PAIR_TICKET_UNSUPPORTED_VERSION"
  ) {
    return message
      ? `Pair confirm request is invalid (400): ${message}. Re-copy the full ticket/QR without truncation.`
      : "Pair confirm request is invalid (400): pairing ticket is malformed. Re-copy the full ticket/QR without truncation.";
  }

  if (status === 400) {
    return message
      ? `Pair confirm request is invalid (400): ${message}`
      : "Pair confirm request is invalid (400).";
  }

  if (status >= 500) {
    return `Proxy pairing service is unavailable (${status}).`;
  }

  if (message) {
    return `Pair confirm failed (${status}): ${message}`;
  }

  return `Pair confirm failed (${status})`;
}

export function mapStatusPairError(status: number, payload: unknown): string {
  const code = extractErrorCode(payload);
  const message = extractErrorMessage(payload);

  if (code === "PROXY_PAIR_TICKET_NOT_FOUND" || status === 404) {
    return "Pairing ticket not found";
  }

  if (code === "PROXY_PAIR_TICKET_EXPIRED" || status === 410) {
    return "Pairing ticket has expired";
  }

  if (code === "PROXY_PAIR_STATUS_FORBIDDEN" || status === 403) {
    return message
      ? `Pair status request is forbidden (403): ${message}`
      : "Pair status request is forbidden (403).";
  }

  if (code === "PROXY_PAIR_TICKET_INVALID_ISSUER") {
    return message
      ? `Pair status failed: ticket issuer does not match this proxy (${message}). Use the same proxy URL where the ticket was issued.`
      : "Pair status failed: ticket issuer does not match this proxy. Use the same proxy URL where the ticket was issued.";
  }

  if (
    code === "PROXY_PAIR_TICKET_INVALID_FORMAT" ||
    code === "PROXY_PAIR_TICKET_UNSUPPORTED_VERSION"
  ) {
    return message
      ? `Pair status request is invalid (400): ${message}. Re-copy the full ticket/QR without truncation.`
      : "Pair status request is invalid (400): pairing ticket is malformed. Re-copy the full ticket/QR without truncation.";
  }

  if (status === 400) {
    return message
      ? `Pair status request is invalid (400): ${message}`
      : "Pair status request is invalid (400).";
  }

  if (status >= 500) {
    return `Proxy pairing service is unavailable (${status}).`;
  }

  if (message) {
    return `Pair status failed (${status}): ${message}`;
  }

  return `Pair status failed (${status})`;
}

export function parsePairStartResponse(
  payload: unknown,
): Omit<PairStartResult, "proxyUrl" | "qrPath"> {
  if (!isRecord(payload)) {
    throw createCliError(
      "CLI_PAIR_START_INVALID_RESPONSE",
      "Pair start response is invalid",
    );
  }

  const ticket = parsePairingTicket(payload.ticket);
  const initiatorAgentDid = parseNonEmptyString(payload.initiatorAgentDid);
  const expiresAt = parseNonEmptyString(payload.expiresAt);

  let initiatorProfile: PairStartResult["initiatorProfile"];
  if (initiatorAgentDid.length === 0 || expiresAt.length === 0) {
    throw createCliError(
      "CLI_PAIR_START_INVALID_RESPONSE",
      "Pair start response is invalid",
    );
  }

  try {
    initiatorProfile = parsePeerProfile(payload.initiatorProfile);
  } catch {
    throw createCliError(
      "CLI_PAIR_START_INVALID_RESPONSE",
      "Pair start response is invalid",
    );
  }

  return {
    ticket,
    initiatorAgentDid,
    initiatorProfile,
    expiresAt,
  };
}

export function parsePairConfirmResponse(
  payload: unknown,
): Omit<PairConfirmResult, "proxyUrl" | "peerAlias"> {
  if (!isRecord(payload)) {
    throw createCliError(
      "CLI_PAIR_CONFIRM_INVALID_RESPONSE",
      "Pair confirm response is invalid",
    );
  }

  const paired = payload.paired === true;
  const initiatorAgentDid = parseNonEmptyString(payload.initiatorAgentDid);
  const responderAgentDid = parseNonEmptyString(payload.responderAgentDid);

  if (
    !paired ||
    initiatorAgentDid.length === 0 ||
    responderAgentDid.length === 0
  ) {
    throw createCliError(
      "CLI_PAIR_CONFIRM_INVALID_RESPONSE",
      "Pair confirm response is invalid",
    );
  }

  let initiatorProfile: PairConfirmResult["initiatorProfile"];
  let responderProfile: PairConfirmResult["responderProfile"];
  try {
    initiatorProfile = parsePeerProfile(payload.initiatorProfile);
    responderProfile = parsePeerProfile(payload.responderProfile);
  } catch {
    throw createCliError(
      "CLI_PAIR_CONFIRM_INVALID_RESPONSE",
      "Pair confirm response is invalid",
    );
  }

  return {
    paired,
    initiatorAgentDid,
    responderAgentDid,
    initiatorProfile,
    responderProfile,
  };
}

export function parsePairStatusResponse(
  payload: unknown,
): Omit<PairStatusResult, "proxyUrl" | "peerAlias"> {
  if (!isRecord(payload)) {
    throw createCliError(
      "CLI_PAIR_STATUS_INVALID_RESPONSE",
      "Pair status response is invalid",
    );
  }

  const statusRaw = parseNonEmptyString(payload.status);
  if (statusRaw !== "pending" && statusRaw !== "confirmed") {
    throw createCliError(
      "CLI_PAIR_STATUS_INVALID_RESPONSE",
      "Pair status response is invalid",
    );
  }

  const initiatorAgentDid = parseNonEmptyString(payload.initiatorAgentDid);
  const responderAgentDid = parseNonEmptyString(payload.responderAgentDid);
  const expiresAt = parseNonEmptyString(payload.expiresAt);
  const confirmedAt = parseNonEmptyString(payload.confirmedAt);

  if (initiatorAgentDid.length === 0 || expiresAt.length === 0) {
    throw createCliError(
      "CLI_PAIR_STATUS_INVALID_RESPONSE",
      "Pair status response is invalid",
    );
  }

  if (statusRaw === "confirmed" && responderAgentDid.length === 0) {
    throw createCliError(
      "CLI_PAIR_STATUS_INVALID_RESPONSE",
      "Pair status response is invalid",
    );
  }

  let initiatorProfile: PairStatusResult["initiatorProfile"];
  try {
    initiatorProfile = parsePeerProfile(payload.initiatorProfile);
  } catch {
    throw createCliError(
      "CLI_PAIR_STATUS_INVALID_RESPONSE",
      "Pair status response is invalid",
    );
  }

  let responderProfile: PairStatusResult["responderProfile"];
  if (payload.responderProfile !== undefined) {
    try {
      responderProfile = parsePeerProfile(payload.responderProfile);
    } catch {
      throw createCliError(
        "CLI_PAIR_STATUS_INVALID_RESPONSE",
        "Pair status response is invalid",
      );
    }
  }

  if (statusRaw === "confirmed" && responderProfile === undefined) {
    throw createCliError(
      "CLI_PAIR_STATUS_INVALID_RESPONSE",
      "Pair status response is invalid",
    );
  }

  return {
    status: statusRaw,
    initiatorAgentDid,
    initiatorProfile,
    responderAgentDid:
      responderAgentDid.length > 0 ? responderAgentDid : undefined,
    responderProfile,
    expiresAt,
    confirmedAt: confirmedAt.length > 0 ? confirmedAt : undefined,
  };
}

export async function readAgentProofMaterial(
  agentName: string,
  dependencies: PairRequestOptions,
): Promise<LocalAgentProofMaterial> {
  const readFileImpl = dependencies.readFileImpl ?? readFile;
  const getConfigDirImpl = dependencies.getConfigDirImpl ?? getConfigDir;
  const normalizedAgentName = assertValidAgentName(agentName);

  const agentDir = join(
    getConfigDirImpl(),
    AGENTS_DIR_NAME,
    normalizedAgentName,
  );
  const aitPath = join(agentDir, AIT_FILE_NAME);
  const secretKeyPath = join(agentDir, SECRET_KEY_FILE_NAME);

  let ait: string;
  try {
    ait = (await readFileImpl(aitPath, "utf-8")).trim();
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      throw createCliError(
        "CLI_PAIR_AGENT_NOT_FOUND",
        `Agent "${normalizedAgentName}" is missing ${AIT_FILE_NAME}. Run agent create first.`,
      );
    }

    throw error;
  }

  if (ait.length === 0) {
    throw createCliError(
      "CLI_PAIR_AGENT_NOT_FOUND",
      `Agent "${normalizedAgentName}" has an empty ${AIT_FILE_NAME}`,
    );
  }

  let encodedSecretKey: string;
  try {
    encodedSecretKey = (await readFileImpl(secretKeyPath, "utf-8")).trim();
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      throw createCliError(
        "CLI_PAIR_AGENT_NOT_FOUND",
        `Agent "${normalizedAgentName}" is missing ${SECRET_KEY_FILE_NAME}. Run agent create first.`,
      );
    }

    throw error;
  }

  if (encodedSecretKey.length === 0) {
    throw createCliError(
      "CLI_PAIR_AGENT_NOT_FOUND",
      `Agent "${normalizedAgentName}" has an empty ${SECRET_KEY_FILE_NAME}`,
    );
  }

  let secretKey: Uint8Array;
  try {
    secretKey = decodeBase64url(encodedSecretKey);
  } catch {
    throw createCliError(
      "CLI_PAIR_AGENT_NOT_FOUND",
      `Agent "${normalizedAgentName}" has invalid ${SECRET_KEY_FILE_NAME}`,
    );
  }

  return {
    ait,
    secretKey,
  };
}

export async function buildSignedHeaders(input: {
  bodyBytes?: Uint8Array;
  method: string;
  requestUrl: string;
  secretKey: Uint8Array;
  timestampSeconds: number;
  nonce: string;
}): Promise<Record<string, string>> {
  const signed = await signHttpRequest({
    method: input.method,
    pathWithQuery: toPathWithQuery(input.requestUrl),
    timestamp: String(input.timestampSeconds),
    nonce: input.nonce,
    body: input.bodyBytes,
    secretKey: input.secretKey,
  });

  return signed.headers;
}

export function resolveConfigWithFallback(
  dependencies: PairRequestOptions,
): () => Promise<CliConfig> {
  return dependencies.resolveConfigImpl ?? resolveConfig;
}
