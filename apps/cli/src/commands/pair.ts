import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { decodeBase64url, parseDid } from "@clawdentity/protocol";
import { AppError, createLogger, signHttpRequest } from "@clawdentity/sdk";
import { Command } from "commander";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import QRCode from "qrcode";
import {
  type CliConfig,
  getConfigDir,
  resolveConfig,
} from "../config/manager.js";
import { fetchRegistryMetadata } from "../config/registry-metadata.js";
import { writeStdoutLine } from "../io.js";
import { assertValidAgentName } from "./agent-name.js";
import { withErrorHandling } from "./helpers.js";

const logger = createLogger({ service: "cli", module: "pair" });

const AGENTS_DIR_NAME = "agents";
const AIT_FILE_NAME = "ait.jwt";
const SECRET_KEY_FILE_NAME = "secret.key";
const PAIRING_QR_DIR_NAME = "pairing";
const PEERS_FILE_NAME = "peers.json";
const OPENCLAW_RELAY_RUNTIME_FILE_NAME = "openclaw-relay.json";

const PAIR_START_PATH = "/pair/start";
const PAIR_CONFIRM_PATH = "/pair/confirm";
const PAIR_STATUS_PATH = "/pair/status";
const NONCE_SIZE = 24;
const PAIRING_TICKET_PREFIX = "clwpair1_";
const PAIRING_QR_MAX_AGE_SECONDS = 900;
const PAIRING_QR_FILENAME_PATTERN = /-pair-(\d+)\.png$/;
const FILE_MODE = 0o600;
const PEER_ALIAS_PATTERN = /^[a-zA-Z0-9._-]+$/;
const DEFAULT_STATUS_WAIT_SECONDS = 300;
const DEFAULT_STATUS_POLL_INTERVAL_SECONDS = 3;
const MAX_PROFILE_NAME_LENGTH = 64;

export type PairStartOptions = {
  ttlSeconds?: string;
  qr?: boolean;
  qrOutput?: string;
  wait?: boolean;
  waitSeconds?: string;
  pollIntervalSeconds?: string;
};

export type PairConfirmOptions = {
  qrFile?: string;
  ticket?: string;
};

export type PairStatusOptions = {
  ticket?: string;
  wait?: boolean;
  waitSeconds?: string;
  pollIntervalSeconds?: string;
};

type PairRequestOptions = {
  fetchImpl?: typeof fetch;
  getConfigDirImpl?: typeof getConfigDir;
  nowSecondsImpl?: () => number;
  nonceFactoryImpl?: () => string;
  readFileImpl?: typeof readFile;
  writeFileImpl?: typeof writeFile;
  chmodImpl?: typeof chmod;
  mkdirImpl?: typeof mkdir;
  readdirImpl?: typeof readdir;
  unlinkImpl?: typeof unlink;
  sleepImpl?: (ms: number) => Promise<void>;
  resolveConfigImpl?: () => Promise<CliConfig>;
  qrEncodeImpl?: (ticket: string) => Promise<Uint8Array>;
  qrDecodeImpl?: (imageBytes: Uint8Array) => string;
};

type PairCommandDependencies = PairRequestOptions;

type PairStartResult = {
  initiatorAgentDid: string;
  initiatorProfile: PeerProfile;
  ticket: string;
  expiresAt: string;
  proxyUrl: string;
  qrPath?: string;
};

type PairConfirmResult = {
  paired: boolean;
  initiatorAgentDid: string;
  initiatorProfile: PeerProfile;
  responderAgentDid: string;
  responderProfile: PeerProfile;
  proxyUrl: string;
  peerAlias?: string;
};

type PairStatusResult = {
  status: "pending" | "confirmed";
  initiatorAgentDid: string;
  initiatorProfile: PeerProfile;
  responderAgentDid?: string;
  responderProfile?: PeerProfile;
  expiresAt: string;
  confirmedAt?: string;
  proxyUrl: string;
  peerAlias?: string;
};

type RegistryErrorEnvelope = {
  error?: {
    code?: string;
    message?: string;
  };
};

type PeerEntry = {
  did: string;
  proxyUrl: string;
  agentName?: string;
  humanName?: string;
};

type PeersConfig = {
  peers: Record<string, PeerEntry>;
};

type LocalAgentProofMaterial = {
  ait: string;
  secretKey: Uint8Array;
};

type PeerProfile = {
  agentName: string;
  humanName: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

function createCliError(code: string, message: string): AppError {
  return new AppError({
    code,
    message,
    status: 400,
  });
}

function parseNonEmptyString(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function hasControlChars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) {
      return true;
    }
  }

  return false;
}

function parseProfileName(
  value: unknown,
  label: "agentName" | "humanName",
): string {
  const candidate = parseNonEmptyString(value);
  if (candidate.length === 0) {
    throw createCliError(
      "CLI_PAIR_PROFILE_INVALID",
      `${label} is required for pairing`,
    );
  }

  if (candidate.length > MAX_PROFILE_NAME_LENGTH) {
    throw createCliError(
      "CLI_PAIR_PROFILE_INVALID",
      `${label} must be at most ${MAX_PROFILE_NAME_LENGTH} characters`,
    );
  }

  if (hasControlChars(candidate)) {
    throw createCliError(
      "CLI_PAIR_PROFILE_INVALID",
      `${label} contains control characters`,
    );
  }

  return candidate;
}

function parsePeerProfile(payload: unknown): PeerProfile {
  if (!isRecord(payload)) {
    throw createCliError(
      "CLI_PAIR_PROFILE_INVALID",
      "Pair profile must be an object",
    );
  }

  return {
    agentName: parseProfileName(payload.agentName, "agentName"),
    humanName: parseProfileName(payload.humanName, "humanName"),
  };
}

function parsePairingTicket(value: unknown): string {
  const ticket = parseNonEmptyString(value);
  if (!ticket.startsWith(PAIRING_TICKET_PREFIX)) {
    throw createCliError(
      "CLI_PAIR_CONFIRM_TICKET_INVALID",
      "Pairing ticket is invalid",
    );
  }

  return ticket;
}

function parsePairingTicketIssuerOrigin(ticket: string): string {
  const encodedPayload = ticket.slice(PAIRING_TICKET_PREFIX.length);
  if (encodedPayload.length === 0) {
    throw createCliError(
      "CLI_PAIR_CONFIRM_TICKET_INVALID",
      "Pairing ticket is invalid",
    );
  }

  let payloadRaw: string;
  try {
    payloadRaw = new TextDecoder().decode(decodeBase64url(encodedPayload));
  } catch {
    throw createCliError(
      "CLI_PAIR_CONFIRM_TICKET_INVALID",
      "Pairing ticket is invalid",
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(payloadRaw);
  } catch {
    throw createCliError(
      "CLI_PAIR_CONFIRM_TICKET_INVALID",
      "Pairing ticket is invalid",
    );
  }

  if (!isRecord(payload) || typeof payload.iss !== "string") {
    throw createCliError(
      "CLI_PAIR_CONFIRM_TICKET_INVALID",
      "Pairing ticket is invalid",
    );
  }

  let issuerUrl: URL;
  try {
    issuerUrl = new URL(payload.iss);
  } catch {
    throw createCliError(
      "CLI_PAIR_CONFIRM_TICKET_INVALID",
      "Pairing ticket is invalid",
    );
  }

  if (issuerUrl.protocol !== "https:" && issuerUrl.protocol !== "http:") {
    throw createCliError(
      "CLI_PAIR_CONFIRM_TICKET_INVALID",
      "Pairing ticket is invalid",
    );
  }

  return issuerUrl.origin;
}

function parseAitAgentDid(ait: string): string {
  const parts = ait.split(".");
  if (parts.length < 2) {
    throw createCliError(
      "CLI_PAIR_AGENT_NOT_FOUND",
      "Agent AIT is invalid. Recreate the agent before pairing.",
    );
  }

  let payloadRaw: string;
  try {
    payloadRaw = new TextDecoder().decode(decodeBase64url(parts[1] ?? ""));
  } catch {
    throw createCliError(
      "CLI_PAIR_AGENT_NOT_FOUND",
      "Agent AIT is invalid. Recreate the agent before pairing.",
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(payloadRaw);
  } catch {
    throw createCliError(
      "CLI_PAIR_AGENT_NOT_FOUND",
      "Agent AIT is invalid. Recreate the agent before pairing.",
    );
  }

  if (!isRecord(payload) || typeof payload.sub !== "string") {
    throw createCliError(
      "CLI_PAIR_AGENT_NOT_FOUND",
      "Agent AIT is invalid. Recreate the agent before pairing.",
    );
  }

  const candidate = payload.sub.trim();
  try {
    const parsed = parseDid(candidate);
    if (parsed.kind !== "agent") {
      throw new Error("invalid kind");
    }
  } catch {
    throw createCliError(
      "CLI_PAIR_AGENT_NOT_FOUND",
      "Agent AIT is invalid. Recreate the agent before pairing.",
    );
  }

  return candidate;
}

function parsePeerAlias(value: string): string {
  if (value.length === 0 || value.length > 128) {
    throw createCliError(
      "CLI_PAIR_PEER_ALIAS_INVALID",
      "Generated peer alias is invalid",
    );
  }

  if (!PEER_ALIAS_PATTERN.test(value)) {
    throw createCliError(
      "CLI_PAIR_PEER_ALIAS_INVALID",
      "Generated peer alias is invalid",
    );
  }

  return value;
}

function derivePeerAliasBase(peerDid: string): string {
  try {
    const parsed = parseDid(peerDid);
    if (parsed.kind === "agent") {
      return parsePeerAlias(`peer-${parsed.ulid.slice(-8).toLowerCase()}`);
    }
  } catch {
    // Fall through to generic alias.
  }

  return "peer";
}

function resolvePeerAlias(input: {
  peers: Record<string, PeerEntry>;
  peerDid: string;
}): string {
  for (const [alias, entry] of Object.entries(input.peers)) {
    if (entry.did === input.peerDid) {
      return alias;
    }
  }

  const baseAlias = derivePeerAliasBase(input.peerDid);
  if (input.peers[baseAlias] === undefined) {
    return baseAlias;
  }

  let index = 2;
  while (input.peers[`${baseAlias}-${index}`] !== undefined) {
    index += 1;
  }

  return `${baseAlias}-${index}`;
}

function resolvePeersConfigPath(getConfigDirImpl: typeof getConfigDir): string {
  return join(getConfigDirImpl(), PEERS_FILE_NAME);
}

function parsePeerEntry(value: unknown): PeerEntry {
  if (!isRecord(value)) {
    throw createCliError(
      "CLI_PAIR_PEERS_CONFIG_INVALID",
      "Peer entry must be an object",
    );
  }

  const did = parseNonEmptyString(value.did);
  const proxyUrl = parseNonEmptyString(value.proxyUrl);
  if (did.length === 0 || proxyUrl.length === 0) {
    throw createCliError(
      "CLI_PAIR_PEERS_CONFIG_INVALID",
      "Peer entry is invalid",
    );
  }

  const agentNameRaw = parseNonEmptyString(value.agentName);
  const humanNameRaw = parseNonEmptyString(value.humanName);

  const entry: PeerEntry = {
    did,
    proxyUrl,
  };
  if (agentNameRaw.length > 0) {
    entry.agentName = parseProfileName(agentNameRaw, "agentName");
  }
  if (humanNameRaw.length > 0) {
    entry.humanName = parseProfileName(humanNameRaw, "humanName");
  }
  return entry;
}

async function loadPeersConfig(input: {
  getConfigDirImpl: typeof getConfigDir;
  readFileImpl: typeof readFile;
}): Promise<PeersConfig> {
  const peersPath = resolvePeersConfigPath(input.getConfigDirImpl);
  let raw: string;
  try {
    raw = await input.readFileImpl(peersPath, "utf8");
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return { peers: {} };
    }

    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw createCliError(
      "CLI_PAIR_PEERS_CONFIG_INVALID",
      "Peer config is not valid JSON",
    );
  }

  if (!isRecord(parsed)) {
    throw createCliError(
      "CLI_PAIR_PEERS_CONFIG_INVALID",
      "Peer config must be a JSON object",
    );
  }

  if (parsed.peers === undefined) {
    return { peers: {} };
  }

  if (!isRecord(parsed.peers)) {
    throw createCliError(
      "CLI_PAIR_PEERS_CONFIG_INVALID",
      "Peer config peers field must be an object",
    );
  }

  const peers: Record<string, PeerEntry> = {};
  for (const [alias, value] of Object.entries(parsed.peers)) {
    peers[parsePeerAlias(alias)] = parsePeerEntry(value);
  }

  return { peers };
}

async function savePeersConfig(input: {
  config: PeersConfig;
  getConfigDirImpl: typeof getConfigDir;
  mkdirImpl: typeof mkdir;
  writeFileImpl: typeof writeFile;
  chmodImpl: typeof chmod;
}): Promise<void> {
  const peersPath = resolvePeersConfigPath(input.getConfigDirImpl);
  await input.mkdirImpl(dirname(peersPath), { recursive: true });
  await input.writeFileImpl(
    peersPath,
    `${JSON.stringify(input.config, null, 2)}\n`,
    "utf8",
  );
  await input.chmodImpl(peersPath, FILE_MODE);
}

function resolveRelayRuntimeConfigPath(
  getConfigDirImpl: typeof getConfigDir,
): string {
  return join(getConfigDirImpl(), OPENCLAW_RELAY_RUNTIME_FILE_NAME);
}

async function loadRelayTransformPeersPath(input: {
  getConfigDirImpl: typeof getConfigDir;
  readFileImpl: typeof readFile;
}): Promise<string | undefined> {
  const relayRuntimeConfigPath = resolveRelayRuntimeConfigPath(
    input.getConfigDirImpl,
  );
  let raw: string;
  try {
    raw = await input.readFileImpl(relayRuntimeConfigPath, "utf8");
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return undefined;
    }

    logger.warn("cli.pair.relay_runtime_read_failed", {
      relayRuntimeConfigPath,
      reason:
        error instanceof Error && error.message.length > 0
          ? error.message
          : "unknown",
    });
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn("cli.pair.relay_runtime_invalid_json", {
      relayRuntimeConfigPath,
    });
    return undefined;
  }

  if (!isRecord(parsed)) {
    return undefined;
  }

  const relayTransformPeersPath = parseNonEmptyString(
    parsed.relayTransformPeersPath,
  );
  if (relayTransformPeersPath.length === 0) {
    return undefined;
  }

  return resolve(relayTransformPeersPath);
}

async function syncOpenclawRelayPeersSnapshot(input: {
  config: PeersConfig;
  getConfigDirImpl: typeof getConfigDir;
  readFileImpl: typeof readFile;
  mkdirImpl: typeof mkdir;
  writeFileImpl: typeof writeFile;
  chmodImpl: typeof chmod;
}): Promise<void> {
  const relayTransformPeersPath = await loadRelayTransformPeersPath({
    getConfigDirImpl: input.getConfigDirImpl,
    readFileImpl: input.readFileImpl,
  });
  if (relayTransformPeersPath === undefined) {
    return;
  }

  try {
    await input.readFileImpl(relayTransformPeersPath, "utf8");
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return;
    }

    logger.warn("cli.pair.relay_peers_snapshot_probe_failed", {
      relayTransformPeersPath,
      reason:
        error instanceof Error && error.message.length > 0
          ? error.message
          : "unknown",
    });
    return;
  }

  try {
    await input.mkdirImpl(dirname(relayTransformPeersPath), {
      recursive: true,
    });
    await input.writeFileImpl(
      relayTransformPeersPath,
      `${JSON.stringify(input.config, null, 2)}\n`,
      "utf8",
    );
    await input.chmodImpl(relayTransformPeersPath, FILE_MODE);
  } catch (error) {
    logger.warn("cli.pair.relay_peers_snapshot_write_failed", {
      relayTransformPeersPath,
      reason:
        error instanceof Error && error.message.length > 0
          ? error.message
          : "unknown",
    });
  }
}

function parseTtlSeconds(value: string | undefined): number | undefined {
  const raw = parseNonEmptyString(value);
  if (raw.length === 0) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw createCliError(
      "CLI_PAIR_START_INVALID_TTL",
      "ttlSeconds must be a positive integer",
    );
  }

  return parsed;
}

function parsePositiveIntegerOption(input: {
  value: string | undefined;
  optionName: string;
  defaultValue: number;
}): number {
  const raw = parseNonEmptyString(input.value);
  if (raw.length === 0) {
    return input.defaultValue;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw createCliError(
      "CLI_PAIR_STATUS_WAIT_INVALID",
      `${input.optionName} must be a positive integer`,
    );
  }

  return parsed;
}

function resolveLocalPairProfile(input: {
  config: CliConfig;
  agentName: string;
}): PeerProfile {
  const humanName = parseNonEmptyString(input.config.humanName);
  if (humanName.length === 0) {
    throw createCliError(
      "CLI_PAIR_HUMAN_NAME_MISSING",
      "Human name is missing. Run `clawdentity invite redeem <clw_inv_...> --display-name <name>` or `clawdentity config set humanName <name>`.",
    );
  }

  return {
    agentName: parseProfileName(input.agentName, "agentName"),
    humanName: parseProfileName(humanName, "humanName"),
  };
}

function parseProxyUrl(candidate: string): string {
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("invalid protocol");
    }

    return parsed.toString();
  } catch {
    throw createCliError("CLI_PAIR_INVALID_PROXY_URL", "Proxy URL is invalid");
  }
}

async function resolveProxyUrl(input: {
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

function toProxyRequestUrl(proxyUrl: string, path: string): string {
  const normalizedBase = proxyUrl.endsWith("/") ? proxyUrl : `${proxyUrl}/`;
  return new URL(path.slice(1), normalizedBase).toString();
}

function toPathWithQuery(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
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

async function parseJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

async function executePairRequest(input: {
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

function mapStartPairError(status: number, payload: unknown): string {
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

function mapConfirmPairError(status: number, payload: unknown): string {
  const code = extractErrorCode(payload);
  const message = extractErrorMessage(payload);

  if (code === "PROXY_PAIR_TICKET_NOT_FOUND" || status === 404) {
    return "Pairing ticket is invalid or expired";
  }

  if (code === "PROXY_PAIR_TICKET_EXPIRED" || status === 410) {
    return "Pairing ticket has expired";
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

function mapStatusPairError(status: number, payload: unknown): string {
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

function parsePairStartResponse(
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
  let initiatorProfile: PeerProfile;

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

function parsePairConfirmResponse(
  payload: unknown,
): Omit<PairConfirmResult, "proxyUrl"> {
  if (!isRecord(payload)) {
    throw createCliError(
      "CLI_PAIR_CONFIRM_INVALID_RESPONSE",
      "Pair confirm response is invalid",
    );
  }

  const paired = payload.paired === true;
  const initiatorAgentDid = parseNonEmptyString(payload.initiatorAgentDid);
  const responderAgentDid = parseNonEmptyString(payload.responderAgentDid);
  let initiatorProfile: PeerProfile;
  let responderProfile: PeerProfile;

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

function parsePairStatusResponse(
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
  let initiatorProfile: PeerProfile;

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
  try {
    initiatorProfile = parsePeerProfile(payload.initiatorProfile);
  } catch {
    throw createCliError(
      "CLI_PAIR_STATUS_INVALID_RESPONSE",
      "Pair status response is invalid",
    );
  }

  let responderProfile: PeerProfile | undefined;
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

async function readAgentProofMaterial(
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

async function buildSignedHeaders(input: {
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

async function encodeTicketQrPng(ticket: string): Promise<Uint8Array> {
  const buffer = await QRCode.toBuffer(ticket, {
    type: "png",
    width: 512,
    margin: 2,
    errorCorrectionLevel: "M",
  });
  return new Uint8Array(buffer);
}

function decodeTicketFromPng(imageBytes: Uint8Array): string {
  let decodedPng: PNG;
  try {
    decodedPng = PNG.sync.read(Buffer.from(imageBytes));
  } catch {
    throw createCliError(
      "CLI_PAIR_CONFIRM_QR_FILE_INVALID",
      "QR image file is invalid or unsupported",
    );
  }

  const imageData = new Uint8ClampedArray(
    decodedPng.data.buffer,
    decodedPng.data.byteOffset,
    decodedPng.data.byteLength,
  );

  const decoded = jsQR(imageData, decodedPng.width, decodedPng.height);
  if (!decoded || parseNonEmptyString(decoded.data).length === 0) {
    throw createCliError(
      "CLI_PAIR_CONFIRM_QR_NOT_FOUND",
      "No pairing QR code was found in the image",
    );
  }

  return parsePairingTicket(decoded.data);
}

async function persistPairingQr(input: {
  agentName: string;
  qrOutput: string | undefined;
  ticket: string;
  dependencies: PairRequestOptions;
  nowSeconds: number;
}): Promise<string> {
  const mkdirImpl = input.dependencies.mkdirImpl ?? mkdir;
  const readdirImpl = input.dependencies.readdirImpl ?? readdir;
  const unlinkImpl = input.dependencies.unlinkImpl ?? unlink;
  const writeFileImpl = input.dependencies.writeFileImpl ?? writeFile;
  const getConfigDirImpl = input.dependencies.getConfigDirImpl ?? getConfigDir;
  const qrEncodeImpl = input.dependencies.qrEncodeImpl ?? encodeTicketQrPng;

  const baseDir = join(getConfigDirImpl(), PAIRING_QR_DIR_NAME);
  const outputPath = parseNonEmptyString(input.qrOutput)
    ? resolve(input.qrOutput ?? "")
    : join(
        baseDir,
        `${assertValidAgentName(input.agentName)}-pair-${input.nowSeconds}.png`,
      );

  const existingFiles = await readdirImpl(baseDir).catch((error) => {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return [] as string[];
    }

    throw error;
  });
  for (const fileName of existingFiles) {
    if (typeof fileName !== "string") {
      continue;
    }

    const match = PAIRING_QR_FILENAME_PATTERN.exec(fileName);
    if (!match) {
      continue;
    }

    const issuedAtSeconds = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isInteger(issuedAtSeconds)) {
      continue;
    }

    if (issuedAtSeconds + PAIRING_QR_MAX_AGE_SECONDS > input.nowSeconds) {
      continue;
    }

    const stalePath = join(baseDir, fileName);
    await unlinkImpl(stalePath).catch((error) => {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        return;
      }

      throw error;
    });
  }

  await mkdirImpl(dirname(outputPath), { recursive: true });
  const imageBytes = await qrEncodeImpl(input.ticket);
  await writeFileImpl(outputPath, imageBytes);

  return outputPath;
}

function resolveConfirmTicketSource(options: PairConfirmOptions): {
  ticket: string;
  source: "ticket" | "qr-file";
  qrFilePath?: string;
} {
  const inlineTicket = parseNonEmptyString(options.ticket);
  const qrFile = parseNonEmptyString(options.qrFile);

  if (inlineTicket.length > 0 && qrFile.length > 0) {
    throw createCliError(
      "CLI_PAIR_CONFIRM_INPUT_CONFLICT",
      "Provide either --ticket or --qr-file, not both",
    );
  }

  if (inlineTicket.length > 0) {
    return {
      ticket: parsePairingTicket(inlineTicket),
      source: "ticket",
    };
  }

  if (qrFile.length > 0) {
    return {
      ticket: "",
      source: "qr-file",
      qrFilePath: resolve(qrFile),
    };
  }

  throw createCliError(
    "CLI_PAIR_CONFIRM_TICKET_REQUIRED",
    "Pairing ticket is required. Pass --ticket <clwpair1_...> or --qr-file <path>.",
  );
}

async function persistPairedPeer(input: {
  ticket: string;
  peerDid: string;
  peerProfile: PeerProfile;
  dependencies: PairRequestOptions;
}): Promise<string> {
  const getConfigDirImpl = input.dependencies.getConfigDirImpl ?? getConfigDir;
  const readFileImpl = input.dependencies.readFileImpl ?? readFile;
  const mkdirImpl = input.dependencies.mkdirImpl ?? mkdir;
  const writeFileImpl = input.dependencies.writeFileImpl ?? writeFile;
  const chmodImpl = input.dependencies.chmodImpl ?? chmod;

  const issuerOrigin = parsePairingTicketIssuerOrigin(input.ticket);
  const peerProxyUrl = new URL("/hooks/agent", `${issuerOrigin}/`).toString();
  const peersConfig = await loadPeersConfig({
    getConfigDirImpl,
    readFileImpl,
  });
  const alias = resolvePeerAlias({
    peers: peersConfig.peers,
    peerDid: input.peerDid,
  });
  peersConfig.peers[alias] = {
    did: input.peerDid,
    proxyUrl: peerProxyUrl,
    agentName: input.peerProfile.agentName,
    humanName: input.peerProfile.humanName,
  };
  await savePeersConfig({
    config: peersConfig,
    getConfigDirImpl,
    mkdirImpl,
    writeFileImpl,
    chmodImpl,
  });
  await syncOpenclawRelayPeersSnapshot({
    config: peersConfig,
    getConfigDirImpl,
    readFileImpl,
    mkdirImpl,
    writeFileImpl,
    chmodImpl,
  });

  return alias;
}

export async function startPairing(
  agentName: string,
  options: PairStartOptions,
  dependencies: PairRequestOptions = {},
): Promise<PairStartResult> {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const resolveConfigImpl = dependencies.resolveConfigImpl ?? resolveConfig;
  const nowSecondsImpl =
    dependencies.nowSecondsImpl ?? (() => Math.floor(Date.now() / 1000));
  const nonceFactoryImpl =
    dependencies.nonceFactoryImpl ??
    (() => randomBytes(NONCE_SIZE).toString("base64url"));

  const ttlSeconds = parseTtlSeconds(options.ttlSeconds);
  const config = await resolveConfigImpl();
  const proxyUrl = await resolveProxyUrl({
    config,
    fetchImpl,
  });
  const normalizedAgentName = assertValidAgentName(agentName);
  const initiatorProfile = resolveLocalPairProfile({
    config,
    agentName: normalizedAgentName,
  });

  const { ait, secretKey } = await readAgentProofMaterial(
    normalizedAgentName,
    dependencies,
  );

  const requestUrl = toProxyRequestUrl(proxyUrl, PAIR_START_PATH);
  const requestBody = JSON.stringify({
    ttlSeconds,
    initiatorProfile,
  });
  const bodyBytes = new TextEncoder().encode(requestBody);

  const timestampSeconds = nowSecondsImpl();
  const nonce = nonceFactoryImpl();
  const signedHeaders = await buildSignedHeaders({
    method: "POST",
    requestUrl,
    bodyBytes,
    secretKey,
    timestampSeconds,
    nonce,
  });

  const response = await executePairRequest({
    fetchImpl,
    url: requestUrl,
    init: {
      method: "POST",
      headers: {
        authorization: `Claw ${ait}`,
        "content-type": "application/json",
        ...signedHeaders,
      },
      body: requestBody,
    },
  });

  const responseBody = await parseJsonResponse(response);

  if (!response.ok) {
    throw createCliError(
      "CLI_PAIR_START_FAILED",
      mapStartPairError(response.status, responseBody),
    );
  }

  const parsed = parsePairStartResponse(responseBody);
  const result: PairStartResult = {
    ...parsed,
    proxyUrl,
  };

  if (options.qr === true) {
    result.qrPath = await persistPairingQr({
      agentName,
      qrOutput: options.qrOutput,
      ticket: parsed.ticket,
      dependencies,
      nowSeconds: timestampSeconds,
    });
  }

  return result;
}

export async function confirmPairing(
  agentName: string,
  options: PairConfirmOptions,
  dependencies: PairRequestOptions = {},
): Promise<PairConfirmResult> {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const resolveConfigImpl = dependencies.resolveConfigImpl ?? resolveConfig;
  const nowSecondsImpl =
    dependencies.nowSecondsImpl ?? (() => Math.floor(Date.now() / 1000));
  const nonceFactoryImpl =
    dependencies.nonceFactoryImpl ??
    (() => randomBytes(NONCE_SIZE).toString("base64url"));
  const readFileImpl = dependencies.readFileImpl ?? readFile;
  const qrDecodeImpl = dependencies.qrDecodeImpl ?? decodeTicketFromPng;
  const config = await resolveConfigImpl();
  const normalizedAgentName = assertValidAgentName(agentName);
  const responderProfile = resolveLocalPairProfile({
    config,
    agentName: normalizedAgentName,
  });

  const ticketSource = resolveConfirmTicketSource(options);
  const proxyUrl = await resolveProxyUrl({
    config,
    fetchImpl,
  });

  let ticket = ticketSource.ticket;
  if (ticketSource.source === "qr-file") {
    if (!ticketSource.qrFilePath) {
      throw createCliError(
        "CLI_PAIR_CONFIRM_QR_FILE_REQUIRED",
        "QR file path is required",
      );
    }

    let imageBytes: Uint8Array;
    try {
      imageBytes = await readFileImpl(ticketSource.qrFilePath);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        throw createCliError(
          "CLI_PAIR_CONFIRM_QR_FILE_NOT_FOUND",
          `QR file not found: ${ticketSource.qrFilePath}`,
        );
      }

      throw error;
    }

    ticket = parsePairingTicket(qrDecodeImpl(new Uint8Array(imageBytes)));
  }

  const { ait, secretKey } = await readAgentProofMaterial(
    normalizedAgentName,
    dependencies,
  );

  const requestUrl = toProxyRequestUrl(proxyUrl, PAIR_CONFIRM_PATH);
  const requestBody = JSON.stringify({
    ticket,
    responderProfile,
  });
  const bodyBytes = new TextEncoder().encode(requestBody);

  const timestampSeconds = nowSecondsImpl();
  const nonce = nonceFactoryImpl();
  const signedHeaders = await buildSignedHeaders({
    method: "POST",
    requestUrl,
    bodyBytes,
    secretKey,
    timestampSeconds,
    nonce,
  });

  const response = await executePairRequest({
    fetchImpl,
    url: requestUrl,
    init: {
      method: "POST",
      headers: {
        authorization: `Claw ${ait}`,
        "content-type": "application/json",
        ...signedHeaders,
      },
      body: requestBody,
    },
  });

  const responseBody = await parseJsonResponse(response);

  if (!response.ok) {
    throw createCliError(
      "CLI_PAIR_CONFIRM_FAILED",
      mapConfirmPairError(response.status, responseBody),
    );
  }

  const parsed = parsePairConfirmResponse(responseBody);
  const peerAlias = await persistPairedPeer({
    ticket,
    peerDid: parsed.initiatorAgentDid,
    peerProfile: parsed.initiatorProfile,
    dependencies,
  });

  if (ticketSource.source === "qr-file" && ticketSource.qrFilePath) {
    const unlinkImpl = dependencies.unlinkImpl ?? unlink;
    await unlinkImpl(ticketSource.qrFilePath).catch((error) => {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        return;
      }

      logger.warn("cli.pair.confirm.qr_cleanup_failed", {
        path: ticketSource.qrFilePath,
        reason:
          error instanceof Error && error.message.length > 0
            ? error.message
            : "unknown",
      });
    });
  }

  return {
    ...parsed,
    proxyUrl,
    peerAlias,
  };
}

async function getPairingStatusOnce(
  agentName: string,
  options: { ticket: string },
  dependencies: PairRequestOptions = {},
): Promise<PairStatusResult> {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const resolveConfigImpl = dependencies.resolveConfigImpl ?? resolveConfig;
  const nowSecondsImpl =
    dependencies.nowSecondsImpl ?? (() => Math.floor(Date.now() / 1000));
  const nonceFactoryImpl =
    dependencies.nonceFactoryImpl ??
    (() => randomBytes(NONCE_SIZE).toString("base64url"));
  const config = await resolveConfigImpl();
  const proxyUrl = await resolveProxyUrl({
    config,
    fetchImpl,
  });

  const ticket = parsePairingTicket(options.ticket);
  const { ait, secretKey } = await readAgentProofMaterial(
    agentName,
    dependencies,
  );
  const callerAgentDid = parseAitAgentDid(ait);

  const requestUrl = toProxyRequestUrl(proxyUrl, PAIR_STATUS_PATH);
  const requestBody = JSON.stringify({ ticket });
  const bodyBytes = new TextEncoder().encode(requestBody);
  const timestampSeconds = nowSecondsImpl();
  const nonce = nonceFactoryImpl();
  const signedHeaders = await buildSignedHeaders({
    method: "POST",
    requestUrl,
    bodyBytes,
    secretKey,
    timestampSeconds,
    nonce,
  });

  const response = await executePairRequest({
    fetchImpl,
    url: requestUrl,
    init: {
      method: "POST",
      headers: {
        authorization: `Claw ${ait}`,
        "content-type": "application/json",
        ...signedHeaders,
      },
      body: requestBody,
    },
  });
  const responseBody = await parseJsonResponse(response);
  if (!response.ok) {
    throw createCliError(
      "CLI_PAIR_STATUS_FAILED",
      mapStatusPairError(response.status, responseBody),
    );
  }

  const parsed = parsePairStatusResponse(responseBody);
  let peerAlias: string | undefined;
  if (parsed.status === "confirmed") {
    const responderAgentDid = parsed.responderAgentDid;
    if (!responderAgentDid) {
      throw createCliError(
        "CLI_PAIR_STATUS_INVALID_RESPONSE",
        "Pair status response is invalid",
      );
    }

    const peerDid =
      callerAgentDid === parsed.initiatorAgentDid
        ? responderAgentDid
        : callerAgentDid === responderAgentDid
          ? parsed.initiatorAgentDid
          : undefined;
    const peerProfile =
      callerAgentDid === parsed.initiatorAgentDid
        ? parsed.responderProfile
        : callerAgentDid === responderAgentDid
          ? parsed.initiatorProfile
          : undefined;
    if (!peerDid) {
      throw createCliError(
        "CLI_PAIR_STATUS_FORBIDDEN",
        "Local agent is not a participant in the pairing ticket",
      );
    }
    if (!peerProfile) {
      throw createCliError(
        "CLI_PAIR_STATUS_INVALID_RESPONSE",
        "Pair status response is invalid",
      );
    }

    peerAlias = await persistPairedPeer({
      ticket,
      peerDid,
      peerProfile,
      dependencies,
    });
  }

  return {
    ...parsed,
    proxyUrl,
    peerAlias,
  };
}

async function waitForPairingStatus(input: {
  agentName: string;
  ticket: string;
  waitSeconds: number;
  pollIntervalSeconds: number;
  dependencies: PairRequestOptions;
}): Promise<PairStatusResult> {
  const nowSecondsImpl =
    input.dependencies.nowSecondsImpl ?? (() => Math.floor(Date.now() / 1000));
  const sleepImpl =
    input.dependencies.sleepImpl ??
    (async (ms: number) => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      });
    });

  const deadlineSeconds = nowSecondsImpl() + input.waitSeconds;
  while (true) {
    const status = await getPairingStatusOnce(
      input.agentName,
      { ticket: input.ticket },
      input.dependencies,
    );

    if (status.status === "confirmed") {
      return status;
    }

    const nowSeconds = nowSecondsImpl();
    if (nowSeconds >= deadlineSeconds) {
      throw createCliError(
        "CLI_PAIR_STATUS_WAIT_TIMEOUT",
        `Pairing is still pending after ${input.waitSeconds} seconds`,
      );
    }

    const remainingSeconds = Math.max(0, deadlineSeconds - nowSeconds);
    const sleepSeconds = Math.min(input.pollIntervalSeconds, remainingSeconds);
    await sleepImpl(sleepSeconds * 1000);
  }
}

export async function getPairingStatus(
  agentName: string,
  options: PairStatusOptions,
  dependencies: PairRequestOptions = {},
): Promise<PairStatusResult> {
  const ticketRaw = parseNonEmptyString(options.ticket);
  if (ticketRaw.length === 0) {
    throw createCliError(
      "CLI_PAIR_STATUS_TICKET_REQUIRED",
      "Pair status requires --ticket <clwpair1_...>",
    );
  }
  const ticket = parsePairingTicket(ticketRaw);

  if (options.wait !== true) {
    return getPairingStatusOnce(agentName, { ticket }, dependencies);
  }

  const waitSeconds = parsePositiveIntegerOption({
    value: options.waitSeconds,
    optionName: "waitSeconds",
    defaultValue: DEFAULT_STATUS_WAIT_SECONDS,
  });
  const pollIntervalSeconds = parsePositiveIntegerOption({
    value: options.pollIntervalSeconds,
    optionName: "pollIntervalSeconds",
    defaultValue: DEFAULT_STATUS_POLL_INTERVAL_SECONDS,
  });

  return waitForPairingStatus({
    agentName,
    ticket,
    waitSeconds,
    pollIntervalSeconds,
    dependencies,
  });
}

export const createPairCommand = (
  dependencies: PairCommandDependencies = {},
): Command => {
  const pairCommand = new Command("pair").description(
    "Manage proxy trust pairing between agents",
  );

  pairCommand
    .command("start <agentName>")
    .description("Start pairing and issue one-time pairing ticket")
    .option("--ttl-seconds <seconds>", "Pairing ticket expiry in seconds")
    .option("--qr", "Generate a local QR file for sharing")
    .option("--qr-output <path>", "Write QR PNG to a specific file path")
    .option(
      "--wait",
      "Wait for responder confirmation and auto-save peer on initiator",
    )
    .option(
      "--wait-seconds <seconds>",
      "Max seconds to poll for confirmation (default: 300)",
    )
    .option(
      "--poll-interval-seconds <seconds>",
      "Polling interval in seconds while waiting (default: 3)",
    )
    .action(
      withErrorHandling(
        "pair start",
        async (agentName: string, options: PairStartOptions) => {
          const result = await startPairing(agentName, options, dependencies);

          logger.info("cli.pair_started", {
            initiatorAgentDid: result.initiatorAgentDid,
            proxyUrl: result.proxyUrl,
            expiresAt: result.expiresAt,
            qrPath: result.qrPath,
          });

          writeStdoutLine("Pairing ticket created");
          writeStdoutLine(`Ticket: ${result.ticket}`);
          writeStdoutLine(`Initiator Agent DID: ${result.initiatorAgentDid}`);
          writeStdoutLine(
            `Initiator Agent Name: ${result.initiatorProfile.agentName}`,
          );
          writeStdoutLine(
            `Initiator Human Name: ${result.initiatorProfile.humanName}`,
          );
          writeStdoutLine(`Expires At: ${result.expiresAt}`);
          if (result.qrPath) {
            writeStdoutLine(`QR File: ${result.qrPath}`);
          }

          if (options.wait === true) {
            const waitSeconds = parsePositiveIntegerOption({
              value: options.waitSeconds,
              optionName: "waitSeconds",
              defaultValue: DEFAULT_STATUS_WAIT_SECONDS,
            });
            const pollIntervalSeconds = parsePositiveIntegerOption({
              value: options.pollIntervalSeconds,
              optionName: "pollIntervalSeconds",
              defaultValue: DEFAULT_STATUS_POLL_INTERVAL_SECONDS,
            });

            writeStdoutLine(
              `Waiting for confirmation (timeout=${waitSeconds}s, interval=${pollIntervalSeconds}s) ...`,
            );

            const status = await waitForPairingStatus({
              agentName,
              ticket: result.ticket,
              waitSeconds,
              pollIntervalSeconds,
              dependencies,
            });

            logger.info("cli.pair_status_confirmed_after_start", {
              initiatorAgentDid: status.initiatorAgentDid,
              responderAgentDid: status.responderAgentDid,
              peerAlias: status.peerAlias,
            });

            writeStdoutLine("Pairing confirmed");
            writeStdoutLine(`Status: ${status.status}`);
            if (status.initiatorAgentDid) {
              writeStdoutLine(
                `Initiator Agent DID: ${status.initiatorAgentDid}`,
              );
            }
            if (status.responderAgentDid) {
              writeStdoutLine(
                `Responder Agent DID: ${status.responderAgentDid}`,
              );
            }
            if (status.responderProfile) {
              writeStdoutLine(
                `Responder Agent Name: ${status.responderProfile.agentName}`,
              );
              writeStdoutLine(
                `Responder Human Name: ${status.responderProfile.humanName}`,
              );
            }
            if (status.peerAlias) {
              writeStdoutLine(`Peer alias saved: ${status.peerAlias}`);
            }
          }
        },
      ),
    );

  pairCommand
    .command("confirm <agentName>")
    .description("Confirm pairing using one-time pairing ticket")
    .option("--ticket <ticket>", "One-time pairing ticket (clwpair1_...)")
    .option("--qr-file <path>", "Path to pairing QR PNG file")
    .action(
      withErrorHandling(
        "pair confirm",
        async (agentName: string, options: PairConfirmOptions) => {
          const result = await confirmPairing(agentName, options, dependencies);

          logger.info("cli.pair_confirmed", {
            initiatorAgentDid: result.initiatorAgentDid,
            responderAgentDid: result.responderAgentDid,
            proxyUrl: result.proxyUrl,
            peerAlias: result.peerAlias,
          });

          writeStdoutLine("Pairing confirmed");
          writeStdoutLine(`Initiator Agent DID: ${result.initiatorAgentDid}`);
          writeStdoutLine(
            `Initiator Agent Name: ${result.initiatorProfile.agentName}`,
          );
          writeStdoutLine(
            `Initiator Human Name: ${result.initiatorProfile.humanName}`,
          );
          writeStdoutLine(`Responder Agent DID: ${result.responderAgentDid}`);
          writeStdoutLine(
            `Responder Agent Name: ${result.responderProfile.agentName}`,
          );
          writeStdoutLine(
            `Responder Human Name: ${result.responderProfile.humanName}`,
          );
          writeStdoutLine(`Paired: ${result.paired ? "true" : "false"}`);
          if (result.peerAlias) {
            writeStdoutLine(`Peer alias saved: ${result.peerAlias}`);
          }
        },
      ),
    );

  pairCommand
    .command("status <agentName>")
    .description("Check pairing ticket status and sync local peer on confirm")
    .option("--ticket <ticket>", "One-time pairing ticket (clwpair1_...)")
    .option("--wait", "Poll until ticket is confirmed or timeout is reached")
    .option(
      "--wait-seconds <seconds>",
      "Max seconds to poll for confirmation (default: 300)",
    )
    .option(
      "--poll-interval-seconds <seconds>",
      "Polling interval in seconds while waiting (default: 3)",
    )
    .action(
      withErrorHandling(
        "pair status",
        async (agentName: string, options: PairStatusOptions) => {
          const result = await getPairingStatus(
            agentName,
            options,
            dependencies,
          );

          logger.info("cli.pair_status", {
            initiatorAgentDid: result.initiatorAgentDid,
            responderAgentDid: result.responderAgentDid,
            status: result.status,
            proxyUrl: result.proxyUrl,
            peerAlias: result.peerAlias,
          });

          writeStdoutLine(`Status: ${result.status}`);
          writeStdoutLine(`Initiator Agent DID: ${result.initiatorAgentDid}`);
          writeStdoutLine(
            `Initiator Agent Name: ${result.initiatorProfile.agentName}`,
          );
          writeStdoutLine(
            `Initiator Human Name: ${result.initiatorProfile.humanName}`,
          );
          if (result.responderAgentDid) {
            writeStdoutLine(`Responder Agent DID: ${result.responderAgentDid}`);
          }
          if (result.responderProfile) {
            writeStdoutLine(
              `Responder Agent Name: ${result.responderProfile.agentName}`,
            );
            writeStdoutLine(
              `Responder Human Name: ${result.responderProfile.humanName}`,
            );
          }
          writeStdoutLine(`Expires At: ${result.expiresAt}`);
          if (result.confirmedAt) {
            writeStdoutLine(`Confirmed At: ${result.confirmedAt}`);
          }
          if (result.peerAlias) {
            writeStdoutLine(`Peer alias saved: ${result.peerAlias}`);
          }
        },
      ),
    );

  return pairCommand;
};
