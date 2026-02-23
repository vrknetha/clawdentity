import { decodeBase64url, parseDid } from "@clawdentity/protocol";
import { AppError, createLogger, nowUtcMs } from "@clawdentity/sdk";
import type { CliConfig } from "../../config/manager.js";
import type { PeerEntry, PeerProfile } from "./types.js";

export const logger = createLogger({ service: "cli", module: "pair" });

export const AGENTS_DIR_NAME = "agents";
export const AIT_FILE_NAME = "ait.jwt";
export const SECRET_KEY_FILE_NAME = "secret.key";
export const PAIRING_QR_DIR_NAME = "pairing";
export const PEERS_FILE_NAME = "peers.json";
export const OPENCLAW_RELAY_RUNTIME_FILE_NAME = "openclaw-relay.json";

export const PAIR_START_PATH = "/pair/start";
export const PAIR_CONFIRM_PATH = "/pair/confirm";
export const PAIR_STATUS_PATH = "/pair/status";
export const NONCE_SIZE = 24;

export const PAIRING_TICKET_PREFIX = "clwpair1_";
export const PAIRING_QR_MAX_AGE_SECONDS = 900;
export const PAIRING_QR_FILENAME_PATTERN = /-pair-(\d+)\.png$/;
export const FILE_MODE = 0o600;
export const PEER_ALIAS_PATTERN = /^[a-zA-Z0-9._-]+$/;
export const DEFAULT_STATUS_WAIT_SECONDS = 300;
export const DEFAULT_STATUS_POLL_INTERVAL_SECONDS = 3;
const MAX_PROFILE_NAME_LENGTH = 64;

const textDecoder = new TextDecoder();

export const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

export const nowUnixSeconds = (): number => Math.floor(nowUtcMs() / 1000);

export function createCliError(code: string, message: string): AppError {
  return new AppError({
    code,
    message,
    status: 400,
  });
}

export function parseNonEmptyString(value: unknown): string {
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

export function parseProfileName(
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

export function parseProxyUrl(candidate: string): string {
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

export function parsePeerProfile(payload: unknown): PeerProfile {
  if (!isRecord(payload)) {
    throw createCliError(
      "CLI_PAIR_PROFILE_INVALID",
      "Pair profile must be an object",
    );
  }

  const profile: PeerProfile = {
    agentName: parseProfileName(payload.agentName, "agentName"),
    humanName: parseProfileName(payload.humanName, "humanName"),
  };

  const proxyOrigin = parseNonEmptyString(payload.proxyOrigin);
  if (proxyOrigin.length > 0) {
    let parsedProxyOrigin: string;
    try {
      parsedProxyOrigin = new URL(parseProxyUrl(proxyOrigin)).origin;
    } catch {
      throw createCliError(
        "CLI_PAIR_PROFILE_INVALID",
        "proxyOrigin is invalid for pairing",
      );
    }
    profile.proxyOrigin = parsedProxyOrigin;
  }

  return profile;
}

export function parsePairingTicket(value: unknown): string {
  let ticket = parseNonEmptyString(value);
  while (ticket.startsWith("`")) {
    ticket = ticket.slice(1);
  }
  while (ticket.endsWith("`")) {
    ticket = ticket.slice(0, -1);
  }
  ticket = ticket.trim().replace(/\s+/gu, "");

  if (!ticket.startsWith(PAIRING_TICKET_PREFIX)) {
    throw createCliError(
      "CLI_PAIR_CONFIRM_TICKET_INVALID",
      "Pairing ticket is invalid",
    );
  }

  const encodedPayload = ticket.slice(PAIRING_TICKET_PREFIX.length);
  if (encodedPayload.length === 0) {
    throw createCliError(
      "CLI_PAIR_CONFIRM_TICKET_INVALID",
      "Pairing ticket is invalid",
    );
  }

  try {
    const payloadRaw = textDecoder.decode(decodeBase64url(encodedPayload));
    const payload = JSON.parse(payloadRaw);
    if (!isRecord(payload)) {
      throw new Error("invalid payload");
    }
  } catch {
    throw createCliError(
      "CLI_PAIR_CONFIRM_TICKET_INVALID",
      "Pairing ticket is invalid",
    );
  }

  return ticket;
}

export function parsePairingTicketIssuerOrigin(ticket: string): string {
  const normalizedTicket = parsePairingTicket(ticket);
  const encodedPayload = normalizedTicket.slice(PAIRING_TICKET_PREFIX.length);
  const payloadRaw = textDecoder.decode(decodeBase64url(encodedPayload));

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

export function assertTicketIssuerMatchesProxy(input: {
  ticket: string;
  proxyUrl: string;
  context: "confirm" | "status";
}): void {
  const issuerOrigin = parsePairingTicketIssuerOrigin(input.ticket);

  let proxyOrigin: string;
  try {
    proxyOrigin = new URL(input.proxyUrl).origin;
  } catch {
    throw createCliError(
      "CLI_PAIR_PROXY_URL_INVALID",
      "Configured proxyUrl is invalid. Run `clawdentity config set proxyUrl <url>` and retry.",
    );
  }

  if (issuerOrigin === proxyOrigin) {
    return;
  }

  const command = input.context === "confirm" ? "pair confirm" : "pair status";
  throw createCliError(
    "CLI_PAIR_TICKET_ISSUER_MISMATCH",
    `Pairing ticket was issued by ${issuerOrigin}, but current proxy URL is ${proxyOrigin}. Run \`clawdentity config set proxyUrl ${issuerOrigin}\` and retry \`${command}\`.`,
  );
}

export function parseAitAgentDid(ait: string): string {
  const parts = ait.split(".");
  if (parts.length < 2) {
    throw createCliError(
      "CLI_PAIR_AGENT_NOT_FOUND",
      "Agent AIT is invalid. Recreate the agent before pairing.",
    );
  }

  let payloadRaw: string;
  try {
    payloadRaw = textDecoder.decode(decodeBase64url(parts[1] ?? ""));
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
    if (parsed.entity !== "agent") {
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

export function parsePeerAlias(value: string): string {
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

export function derivePeerAliasBase(peerDid: string): string {
  try {
    const parsed = parseDid(peerDid);
    if (parsed.entity === "agent") {
      return parsePeerAlias(`peer-${parsed.ulid.slice(-8).toLowerCase()}`);
    }
  } catch {
    // Fall through to generic alias.
  }

  return "peer";
}

export function parseTtlSeconds(value: string | undefined): number | undefined {
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

export function parsePositiveIntegerOption(input: {
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

export function resolveLocalPairProfile(input: {
  config: CliConfig;
  agentName: string;
  proxyUrl?: string;
}): PeerProfile {
  const humanName = parseNonEmptyString(input.config.humanName);
  if (humanName.length === 0) {
    throw createCliError(
      "CLI_PAIR_HUMAN_NAME_MISSING",
      "Human name is missing. Run `clawdentity invite redeem <clw_inv_...> --display-name <name>` or `clawdentity config set humanName <name>`.",
    );
  }

  const profile: PeerProfile = {
    agentName: parseProfileName(input.agentName, "agentName"),
    humanName: parseProfileName(humanName, "humanName"),
  };

  const proxyUrl = parseNonEmptyString(input.proxyUrl);
  if (proxyUrl.length > 0) {
    profile.proxyOrigin = new URL(parseProxyUrl(proxyUrl)).origin;
  }

  return profile;
}

function normalizeProxyOrigin(candidate: string): string {
  return new URL(parseProxyUrl(candidate)).origin;
}

export function resolvePeerProxyUrl(input: {
  ticket: string;
  peerProfile: PeerProfile;
  peerProxyOrigin?: string;
}): string {
  const configuredPeerOrigin = parseNonEmptyString(input.peerProxyOrigin);
  const profilePeerOrigin = parseNonEmptyString(input.peerProfile.proxyOrigin);
  const fallbackPeerOrigin = parsePairingTicketIssuerOrigin(input.ticket);
  const peerOrigin =
    configuredPeerOrigin.length > 0
      ? configuredPeerOrigin
      : profilePeerOrigin.length > 0
        ? profilePeerOrigin
        : fallbackPeerOrigin;

  return new URL(
    "/hooks/agent",
    `${normalizeProxyOrigin(peerOrigin)}/`,
  ).toString();
}

export function toPeerProxyOriginFromStatus(input: {
  callerAgentDid: string;
  initiatorAgentDid: string;
  responderAgentDid: string;
  initiatorProfile: PeerProfile;
  responderProfile?: PeerProfile;
}): string | undefined {
  if (input.callerAgentDid === input.initiatorAgentDid) {
    return input.responderProfile?.proxyOrigin;
  }

  if (input.callerAgentDid === input.responderAgentDid) {
    return input.initiatorProfile.proxyOrigin;
  }

  return undefined;
}

export function toPeerProxyOriginFromConfirm(input: {
  ticket: string;
  initiatorProfile: PeerProfile;
}): string {
  const initiatorOrigin = parseNonEmptyString(
    input.initiatorProfile.proxyOrigin,
  );
  if (initiatorOrigin.length > 0) {
    return initiatorOrigin;
  }

  return parsePairingTicketIssuerOrigin(input.ticket);
}

export function toResponderProfile(input: {
  config: CliConfig;
  agentName: string;
  localProxyUrl: string;
}): PeerProfile {
  return resolveLocalPairProfile({
    config: input.config,
    agentName: input.agentName,
    proxyUrl: input.localProxyUrl,
  });
}

export function toPathWithQuery(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

export function parsePeerEntry(value: unknown): PeerEntry {
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
