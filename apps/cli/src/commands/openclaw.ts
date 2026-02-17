import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  decodeBase64url,
  encodeBase64url,
  parseDid,
} from "@clawdentity/protocol";
import { AppError, createLogger, nowIso } from "@clawdentity/sdk";
import { Command } from "commander";
import { resolveConfig } from "../config/manager.js";
import { writeStdoutLine } from "../io.js";
import { assertValidAgentName } from "./agent-name.js";
import { withErrorHandling } from "./helpers.js";

const logger = createLogger({ service: "cli", module: "openclaw" });

const CLAWDENTITY_DIR_NAME = ".clawdentity";
const AGENTS_DIR_NAME = "agents";
const AIT_FILE_NAME = "ait.jwt";
const SECRET_KEY_FILE_NAME = "secret.key";
const PEERS_FILE_NAME = "peers.json";
const OPENCLAW_DIR_NAME = ".openclaw";
const OPENCLAW_CONFIG_FILE_NAME = "openclaw.json";
const OPENCLAW_AGENT_FILE_NAME = "openclaw-agent-name";
const OPENCLAW_RELAY_RUNTIME_FILE_NAME = "openclaw-relay.json";
const SKILL_DIR_NAME = "clawdentity-openclaw-relay";
const RELAY_MODULE_FILE_NAME = "relay-to-peer.mjs";
const HOOK_MAPPING_ID = "clawdentity-send-to-peer";
const HOOK_PATH_SEND_TO_PEER = "send-to-peer";
const OPENCLAW_SEND_TO_PEER_HOOK_PATH = "hooks/send-to-peer";
const DEFAULT_OPENCLAW_BASE_URL = "http://127.0.0.1:18789";
const INVITE_CODE_PREFIX = "clawd1_";
const PEER_ALIAS_PATTERN = /^[a-zA-Z0-9._-]+$/;
const FILE_MODE = 0o600;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

type OpenclawInvitePayload = {
  v: 1;
  issuedAt: string;
  did: string;
  proxyUrl: string;
  alias?: string;
  name?: string;
};

type OpenclawInviteOptions = {
  did: string;
  proxyUrl: string;
  peerAlias?: string;
  name?: string;
};

type OpenclawSetupOptions = {
  inviteCode: string;
  peerAlias?: string;
  openclawDir?: string;
  transformSource?: string;
  openclawBaseUrl?: string;
  homeDir?: string;
};

type OpenclawDoctorOptions = {
  homeDir?: string;
  openclawDir?: string;
  peerAlias?: string;
  resolveConfigImpl?: typeof resolveConfig;
  json?: boolean;
};

type OpenclawRelayTestOptions = {
  peer: string;
  homeDir?: string;
  openclawDir?: string;
  openclawBaseUrl?: string;
  hookToken?: string;
  sessionId?: string;
  message?: string;
  fetchImpl?: typeof fetch;
  resolveConfigImpl?: typeof resolveConfig;
  json?: boolean;
};

type PeerEntry = {
  did: string;
  proxyUrl: string;
  name?: string;
};

type PeersConfig = {
  peers: Record<string, PeerEntry>;
};

export type OpenclawInviteResult = {
  code: string;
  did: string;
  proxyUrl: string;
  peerAlias?: string;
  name?: string;
};

export type OpenclawSetupResult = {
  peerAlias: string;
  peerDid: string;
  peerProxyUrl: string;
  openclawConfigPath: string;
  transformTargetPath: string;
  openclawBaseUrl: string;
  relayRuntimeConfigPath: string;
};

type OpenclawRelayRuntimeConfig = {
  openclawBaseUrl: string;
  updatedAt?: string;
};

type OpenclawDoctorCheckId =
  | "config.registry"
  | "state.selectedAgent"
  | "state.credentials"
  | "state.peers"
  | "state.transform"
  | "state.hookMapping"
  | "state.openclawBaseUrl";

type OpenclawDoctorCheckStatus = "pass" | "fail";

export type OpenclawDoctorCheckResult = {
  id: OpenclawDoctorCheckId;
  label: string;
  status: OpenclawDoctorCheckStatus;
  message: string;
  remediationHint?: string;
  details?: Record<string, unknown>;
};

export type OpenclawDoctorResult = {
  status: "healthy" | "unhealthy";
  checkedAt: string;
  checks: OpenclawDoctorCheckResult[];
};

export type OpenclawRelayTestResult = {
  status: "success" | "failure";
  checkedAt: string;
  peerAlias: string;
  endpoint: string;
  message: string;
  httpStatus?: number;
  remediationHint?: string;
  details?: Record<string, unknown>;
  preflight?: OpenclawDoctorResult;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createCliError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): AppError {
  return new AppError({
    code,
    message,
    status: 400,
    details,
  });
}

function getErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  return typeof error.code === "string" ? error.code : undefined;
}

function parseNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_INPUT",
      "Input must be a string",
      {
        label,
      },
    );
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_INPUT",
      "Input must not be empty",
      { label },
    );
  }

  return trimmed;
}

function parseOptionalName(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return parseNonEmptyString(value, "name");
}

function parsePeerAlias(value: unknown): string {
  const alias = parseNonEmptyString(value, "peer alias");
  if (alias.length > 128) {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_PEER_ALIAS",
      "peer alias must be at most 128 characters",
    );
  }

  if (!PEER_ALIAS_PATTERN.test(alias)) {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_PEER_ALIAS",
      "peer alias must use only letters, numbers, dot, underscore, or hyphen",
    );
  }

  return alias;
}

function parseProxyUrl(value: unknown): string {
  return parseHttpUrl(value, {
    label: "proxy URL",
    code: "CLI_OPENCLAW_INVALID_PROXY_URL",
    message: "proxy URL must be a valid URL",
  });
}

function parseHttpUrl(
  value: unknown,
  input: {
    label: string;
    code: string;
    message: string;
  },
): string {
  const candidate = parseNonEmptyString(value, input.label);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(candidate);
  } catch {
    throw createCliError(input.code, input.message);
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw createCliError(input.code, `${input.label} must use http or https`);
  }

  if (
    parsedUrl.pathname === "/" &&
    parsedUrl.search.length === 0 &&
    parsedUrl.hash.length === 0
  ) {
    return parsedUrl.origin;
  }

  return parsedUrl.toString();
}

function parseOpenclawBaseUrl(value: unknown): string {
  return parseHttpUrl(value, {
    label: "OpenClaw base URL",
    code: "CLI_OPENCLAW_INVALID_OPENCLAW_BASE_URL",
    message: "OpenClaw base URL must be a valid URL",
  });
}

function parseAgentDid(value: unknown, label: string): string {
  const did = parseNonEmptyString(value, label);

  try {
    const parsed = parseDid(did);
    if (parsed.kind !== "agent") {
      throw createCliError(
        "CLI_OPENCLAW_INVALID_DID",
        "DID is not an agent DID",
      );
    }
  } catch {
    throw createCliError("CLI_OPENCLAW_INVALID_DID", "Agent DID is invalid", {
      label,
    });
  }

  return did;
}

function parseInvitePayload(value: unknown): OpenclawInvitePayload {
  if (!isRecord(value)) {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_INVITE",
      "invite payload must be an object",
    );
  }

  if (value.v !== 1) {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_INVITE",
      "invite payload version is unsupported",
    );
  }

  const issuedAt = parseNonEmptyString(value.issuedAt, "invite issuedAt");
  const did = parseAgentDid(value.did, "invite did");
  const proxyUrl = parseProxyUrl(value.proxyUrl);
  const alias =
    value.alias === undefined ? undefined : parsePeerAlias(value.alias);
  const name = parseOptionalName(value.name);

  if (alias === undefined && name === undefined) {
    return {
      v: 1,
      issuedAt,
      did,
      proxyUrl,
    };
  }

  if (name === undefined) {
    return {
      v: 1,
      issuedAt,
      did,
      proxyUrl,
      alias,
    };
  }

  return {
    v: 1,
    issuedAt,
    did,
    proxyUrl,
    alias,
    name,
  };
}

function resolveHomeDir(homeDir?: string): string {
  if (typeof homeDir === "string" && homeDir.trim().length > 0) {
    return homeDir.trim();
  }

  return homedir();
}

function resolveOpenclawDir(openclawDir: string | undefined, homeDir: string) {
  if (typeof openclawDir === "string" && openclawDir.trim().length > 0) {
    return openclawDir.trim();
  }

  return join(homeDir, OPENCLAW_DIR_NAME);
}

function resolveAgentDirectory(homeDir: string, agentName: string): string {
  return join(homeDir, CLAWDENTITY_DIR_NAME, AGENTS_DIR_NAME, agentName);
}

function resolvePeersPath(homeDir: string): string {
  return join(homeDir, CLAWDENTITY_DIR_NAME, PEERS_FILE_NAME);
}

function resolveOpenclawConfigPath(openclawDir: string): string {
  return join(openclawDir, OPENCLAW_CONFIG_FILE_NAME);
}

function resolveDefaultTransformSource(openclawDir: string): string {
  return join(
    openclawDir,
    "workspace",
    "skills",
    SKILL_DIR_NAME,
    RELAY_MODULE_FILE_NAME,
  );
}

function resolveTransformTargetPath(openclawDir: string): string {
  return join(openclawDir, "hooks", "transforms", RELAY_MODULE_FILE_NAME);
}

function resolveOpenclawAgentNamePath(homeDir: string): string {
  return join(homeDir, CLAWDENTITY_DIR_NAME, OPENCLAW_AGENT_FILE_NAME);
}

function resolveRelayRuntimeConfigPath(homeDir: string): string {
  return join(homeDir, CLAWDENTITY_DIR_NAME, OPENCLAW_RELAY_RUNTIME_FILE_NAME);
}

async function readJsonFile(filePath: string): Promise<unknown> {
  const raw = await readFile(filePath, "utf8");

  try {
    return JSON.parse(raw);
  } catch {
    throw createCliError("CLI_OPENCLAW_INVALID_JSON", "JSON file is invalid", {
      filePath,
    });
  }
}

async function ensureLocalAgentCredentials(
  homeDir: string,
  agentName: string,
): Promise<void> {
  const agentDir = resolveAgentDirectory(homeDir, agentName);
  const requiredFiles = [
    join(agentDir, SECRET_KEY_FILE_NAME),
    join(agentDir, AIT_FILE_NAME),
  ];

  for (const filePath of requiredFiles) {
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") {
        throw createCliError(
          "CLI_OPENCLAW_MISSING_AGENT_CREDENTIALS",
          "Local agent credentials are missing",
          { agentName, filePath },
        );
      }

      throw error;
    }

    if (content.trim().length === 0) {
      throw createCliError(
        "CLI_OPENCLAW_EMPTY_AGENT_CREDENTIALS",
        "Agent credential file is empty",
        { filePath },
      );
    }
  }
}

function encodeInvitePayload(payload: OpenclawInvitePayload): string {
  const encoded = encodeBase64url(textEncoder.encode(JSON.stringify(payload)));
  return `${INVITE_CODE_PREFIX}${encoded}`;
}

function decodeInvitePayload(code: string): OpenclawInvitePayload {
  const rawCode = parseNonEmptyString(code, "invite code");
  if (!rawCode.startsWith(INVITE_CODE_PREFIX)) {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_INVITE",
      "Invite code has invalid prefix",
    );
  }

  const encoded = rawCode.slice(INVITE_CODE_PREFIX.length);
  if (encoded.length === 0) {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_INVITE",
      "invite code payload is empty",
    );
  }

  let decodedJson: string;
  try {
    decodedJson = textDecoder.decode(decodeBase64url(encoded));
  } catch {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_INVITE",
      "invite code payload is not valid base64url",
    );
  }

  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(decodedJson);
  } catch {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_INVITE",
      "invite code payload is not valid JSON",
    );
  }

  return parseInvitePayload(parsedPayload);
}

async function writeSecureFile(
  filePath: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  await chmod(filePath, FILE_MODE);
}

async function loadPeersConfig(peersPath: string): Promise<PeersConfig> {
  let parsed: unknown;

  try {
    parsed = await readJsonFile(peersPath);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return { peers: {} };
    }

    throw error;
  }

  if (!isRecord(parsed)) {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_PEERS_CONFIG",
      "Peer config root must be a JSON object",
      { peersPath },
    );
  }

  const peersValue = parsed.peers;
  if (peersValue === undefined) {
    return { peers: {} };
  }

  if (!isRecord(peersValue)) {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_PEERS_CONFIG",
      "Peer config peers field must be an object",
      { peersPath },
    );
  }

  const peers: Record<string, PeerEntry> = {};
  for (const [alias, value] of Object.entries(peersValue)) {
    const normalizedAlias = parsePeerAlias(alias);
    if (!isRecord(value)) {
      throw createCliError(
        "CLI_OPENCLAW_INVALID_PEERS_CONFIG",
        "Peer entry must be an object",
        { alias: normalizedAlias },
      );
    }

    const did = parseAgentDid(value.did, `Peer ${normalizedAlias} did`);
    const proxyUrl = parseProxyUrl(value.proxyUrl);
    const name = parseOptionalName(value.name);

    if (name === undefined) {
      peers[normalizedAlias] = { did, proxyUrl };
      continue;
    }

    peers[normalizedAlias] = { did, proxyUrl, name };
  }

  return { peers };
}

async function savePeersConfig(
  peersPath: string,
  config: PeersConfig,
): Promise<void> {
  await writeSecureFile(peersPath, `${JSON.stringify(config, null, 2)}\n`);
}

function parseRelayRuntimeConfig(
  value: unknown,
  relayRuntimeConfigPath: string,
): OpenclawRelayRuntimeConfig {
  if (!isRecord(value)) {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_RELAY_RUNTIME_CONFIG",
      "Relay runtime config must be an object",
      { relayRuntimeConfigPath },
    );
  }

  const updatedAt =
    typeof value.updatedAt === "string" && value.updatedAt.trim().length > 0
      ? value.updatedAt.trim()
      : undefined;

  return {
    openclawBaseUrl: parseOpenclawBaseUrl(value.openclawBaseUrl),
    updatedAt,
  };
}

async function loadRelayRuntimeConfig(
  relayRuntimeConfigPath: string,
): Promise<OpenclawRelayRuntimeConfig | undefined> {
  let parsed: unknown;
  try {
    parsed = await readJsonFile(relayRuntimeConfigPath);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return undefined;
    }

    throw error;
  }

  return parseRelayRuntimeConfig(parsed, relayRuntimeConfigPath);
}

async function saveRelayRuntimeConfig(
  relayRuntimeConfigPath: string,
  openclawBaseUrl: string,
): Promise<void> {
  const config: OpenclawRelayRuntimeConfig = {
    openclawBaseUrl,
    updatedAt: nowIso(),
  };

  await writeSecureFile(
    relayRuntimeConfigPath,
    `${JSON.stringify(config, null, 2)}\n`,
  );
}

async function resolveOpenclawBaseUrl(input: {
  optionValue?: string;
  relayRuntimeConfigPath: string;
}): Promise<string> {
  if (
    typeof input.optionValue === "string" &&
    input.optionValue.trim().length > 0
  ) {
    return parseOpenclawBaseUrl(input.optionValue);
  }

  const envOpenclawBaseUrl = process.env.OPENCLAW_BASE_URL;
  if (
    typeof envOpenclawBaseUrl === "string" &&
    envOpenclawBaseUrl.trim().length > 0
  ) {
    return parseOpenclawBaseUrl(envOpenclawBaseUrl);
  }

  const existingConfig = await loadRelayRuntimeConfig(
    input.relayRuntimeConfigPath,
  );
  if (existingConfig !== undefined) {
    return existingConfig.openclawBaseUrl;
  }

  return DEFAULT_OPENCLAW_BASE_URL;
}

function normalizeStringArrayWithValue(
  value: unknown,
  requiredValue: string,
): string[] {
  const normalized = new Set<string>();

  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== "string") {
        continue;
      }

      const trimmed = item.trim();
      if (trimmed.length > 0) {
        normalized.add(trimmed);
      }
    }
  }

  normalized.add(requiredValue);

  return Array.from(normalized);
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

async function patchOpenclawConfig(openclawConfigPath: string): Promise<void> {
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

  hooks.enabled = true;
  hooks.allowRequestSessionKey = false;
  hooks.allowedSessionKeyPrefixes = normalizeStringArrayWithValue(
    hooks.allowedSessionKeyPrefixes,
    "hook:",
  );
  hooks.mappings = upsertRelayHookMapping(hooks.mappings);

  const nextConfig = {
    ...config,
    hooks,
  };

  await writeFile(
    openclawConfigPath,
    `${JSON.stringify(nextConfig, null, 2)}\n`,
    "utf8",
  );
}

function toDoctorCheck(
  input: OpenclawDoctorCheckResult,
): OpenclawDoctorCheckResult {
  return input;
}

function toDoctorResult(
  checks: OpenclawDoctorCheckResult[],
): OpenclawDoctorResult {
  return {
    status: checks.every((check) => check.status === "pass")
      ? "healthy"
      : "unhealthy",
    checkedAt: nowIso(),
    checks,
  };
}

function isRelayHookMapping(value: unknown): boolean {
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

function hasRelayTransformModule(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.transform)) {
    return false;
  }

  return value.transform.module === RELAY_MODULE_FILE_NAME;
}

function parseDoctorPeerAlias(peerAlias?: string): string | undefined {
  if (peerAlias === undefined) {
    return undefined;
  }

  return parsePeerAlias(peerAlias);
}

function resolveHookToken(optionValue?: string): string | undefined {
  const trimmedOption = optionValue?.trim();
  if (trimmedOption !== undefined && trimmedOption.length > 0) {
    return trimmedOption;
  }

  const envValue = process.env.OPENCLAW_HOOK_TOKEN?.trim();
  if (envValue !== undefined && envValue.length > 0) {
    return envValue;
  }

  return undefined;
}

function resolveProbeMessage(optionValue?: string): string {
  const trimmed = optionValue?.trim();
  if (trimmed !== undefined && trimmed.length > 0) {
    return trimmed;
  }

  return "clawdentity relay probe";
}

function resolveProbeSessionId(optionValue?: string): string {
  const trimmed = optionValue?.trim();
  if (trimmed !== undefined && trimmed.length > 0) {
    return trimmed;
  }

  return "clawdentity-relay-test";
}

function formatDoctorCheckLine(check: OpenclawDoctorCheckResult): string {
  const icon = check.status === "pass" ? "✅" : "❌";
  return `${icon} ${check.label}: ${check.message}`;
}

function printDoctorResult(result: OpenclawDoctorResult): void {
  writeStdoutLine(`OpenClaw doctor status: ${result.status}`);
  for (const check of result.checks) {
    writeStdoutLine(formatDoctorCheckLine(check));
    if (check.status === "fail" && check.remediationHint) {
      writeStdoutLine(`Fix: ${check.remediationHint}`);
    }
  }
}

function printRelayTestResult(result: OpenclawRelayTestResult): void {
  writeStdoutLine(`Relay test status: ${result.status}`);
  writeStdoutLine(`Peer alias: ${result.peerAlias}`);
  writeStdoutLine(`Endpoint: ${result.endpoint}`);
  if (typeof result.httpStatus === "number") {
    writeStdoutLine(`HTTP status: ${result.httpStatus}`);
  }
  writeStdoutLine(`Message: ${result.message}`);
  if (result.remediationHint) {
    writeStdoutLine(`Fix: ${result.remediationHint}`);
  }
}

function toSendToPeerEndpoint(openclawBaseUrl: string): string {
  const normalizedBase = openclawBaseUrl.endsWith("/")
    ? openclawBaseUrl
    : `${openclawBaseUrl}/`;
  return new URL(OPENCLAW_SEND_TO_PEER_HOOK_PATH, normalizedBase).toString();
}

export async function runOpenclawDoctor(
  options: OpenclawDoctorOptions = {},
): Promise<OpenclawDoctorResult> {
  const homeDir = resolveHomeDir(options.homeDir);
  const openclawDir = resolveOpenclawDir(options.openclawDir, homeDir);
  const peerAlias = parseDoctorPeerAlias(options.peerAlias);
  const checks: OpenclawDoctorCheckResult[] = [];

  const resolveConfigImpl = options.resolveConfigImpl ?? resolveConfig;
  try {
    const resolvedConfig = await resolveConfigImpl();
    if (
      typeof resolvedConfig.registryUrl !== "string" ||
      resolvedConfig.registryUrl.trim().length === 0
    ) {
      checks.push(
        toDoctorCheck({
          id: "config.registry",
          label: "CLI config",
          status: "fail",
          message: "registryUrl is missing",
          remediationHint:
            "Run: clawdentity config set registryUrl <REGISTRY_URL>",
        }),
      );
    } else if (
      typeof resolvedConfig.apiKey !== "string" ||
      resolvedConfig.apiKey.trim().length === 0
    ) {
      checks.push(
        toDoctorCheck({
          id: "config.registry",
          label: "CLI config",
          status: "fail",
          message: "apiKey is missing",
          remediationHint: "Run: clawdentity config set apiKey <API_KEY>",
        }),
      );
    } else {
      checks.push(
        toDoctorCheck({
          id: "config.registry",
          label: "CLI config",
          status: "pass",
          message: "registryUrl and apiKey are configured",
        }),
      );
    }
  } catch {
    checks.push(
      toDoctorCheck({
        id: "config.registry",
        label: "CLI config",
        status: "fail",
        message: "unable to resolve CLI config",
        remediationHint:
          "Fix ~/.clawdentity/config.json or rerun: clawdentity config init",
      }),
    );
  }

  const selectedAgentPath = resolveOpenclawAgentNamePath(homeDir);
  let selectedAgentName: string | undefined;
  try {
    const selectedAgentRaw = await readFile(selectedAgentPath, "utf8");
    selectedAgentName = assertValidAgentName(selectedAgentRaw.trim());
    checks.push(
      toDoctorCheck({
        id: "state.selectedAgent",
        label: "Selected agent marker",
        status: "pass",
        message: `selected agent is ${selectedAgentName}`,
      }),
    );
  } catch (error) {
    const missing = getErrorCode(error) === "ENOENT";
    checks.push(
      toDoctorCheck({
        id: "state.selectedAgent",
        label: "Selected agent marker",
        status: "fail",
        message: missing
          ? `missing ${selectedAgentPath}`
          : "selected agent marker is invalid",
        remediationHint:
          "Run: clawdentity openclaw setup <agentName> --invite-code <code>",
      }),
    );
  }

  if (selectedAgentName === undefined) {
    checks.push(
      toDoctorCheck({
        id: "state.credentials",
        label: "Local agent credentials",
        status: "fail",
        message: "cannot validate credentials without selected agent marker",
        remediationHint:
          "Run: clawdentity openclaw setup <agentName> --invite-code <code>",
      }),
    );
  } else {
    try {
      await ensureLocalAgentCredentials(homeDir, selectedAgentName);
      checks.push(
        toDoctorCheck({
          id: "state.credentials",
          label: "Local agent credentials",
          status: "pass",
          message: "ait.jwt and secret.key are present",
        }),
      );
    } catch (error) {
      const details = error instanceof AppError ? error.details : undefined;
      const filePath =
        details && typeof details.filePath === "string"
          ? details.filePath
          : undefined;
      checks.push(
        toDoctorCheck({
          id: "state.credentials",
          label: "Local agent credentials",
          status: "fail",
          message:
            filePath === undefined
              ? "agent credentials are missing or invalid"
              : `credential file missing or empty: ${filePath}`,
          remediationHint:
            "Run: clawdentity agent create <agentName> --framework openclaw",
          details:
            filePath === undefined
              ? undefined
              : { filePath, selectedAgentName },
        }),
      );
    }
  }

  const peersPath = resolvePeersPath(homeDir);
  let peersConfig: PeersConfig | undefined;
  try {
    peersConfig = await loadPeersConfig(peersPath);
    const peerAliases = Object.keys(peersConfig.peers);
    if (peerAlias !== undefined) {
      if (peersConfig.peers[peerAlias] === undefined) {
        checks.push(
          toDoctorCheck({
            id: "state.peers",
            label: "Peers map",
            status: "fail",
            message: `peer alias is missing: ${peerAlias}`,
            remediationHint:
              "Run: clawdentity openclaw setup <agentName> --invite-code <code> --peer-alias <alias>",
            details: { peersPath, peerAlias },
          }),
        );
      } else {
        checks.push(
          toDoctorCheck({
            id: "state.peers",
            label: "Peers map",
            status: "pass",
            message: `peer alias exists: ${peerAlias}`,
            details: { peersPath, peerAlias },
          }),
        );
      }
    } else if (peerAliases.length === 0) {
      checks.push(
        toDoctorCheck({
          id: "state.peers",
          label: "Peers map",
          status: "fail",
          message: "no peers are configured",
          remediationHint:
            "Run: clawdentity openclaw setup <agentName> --invite-code <code>",
          details: { peersPath },
        }),
      );
    } else {
      checks.push(
        toDoctorCheck({
          id: "state.peers",
          label: "Peers map",
          status: "pass",
          message: `configured peers: ${peerAliases.length}`,
          details: { peersPath },
        }),
      );
    }
  } catch {
    checks.push(
      toDoctorCheck({
        id: "state.peers",
        label: "Peers map",
        status: "fail",
        message: `invalid peers config at ${peersPath}`,
        remediationHint:
          "Fix JSON in ~/.clawdentity/peers.json or rerun openclaw setup",
        details: { peersPath },
      }),
    );
  }

  const transformTargetPath = resolveTransformTargetPath(openclawDir);
  try {
    const transformContents = await readFile(transformTargetPath, "utf8");
    if (transformContents.trim().length === 0) {
      checks.push(
        toDoctorCheck({
          id: "state.transform",
          label: "Relay transform",
          status: "fail",
          message: `transform file is empty: ${transformTargetPath}`,
          remediationHint: "Run: npm install clawdentity --skill",
          details: { transformTargetPath },
        }),
      );
    } else {
      checks.push(
        toDoctorCheck({
          id: "state.transform",
          label: "Relay transform",
          status: "pass",
          message: "relay transform file exists",
          details: { transformTargetPath },
        }),
      );
    }
  } catch {
    checks.push(
      toDoctorCheck({
        id: "state.transform",
        label: "Relay transform",
        status: "fail",
        message: `missing transform file: ${transformTargetPath}`,
        remediationHint: "Run: npm install clawdentity --skill",
        details: { transformTargetPath },
      }),
    );
  }

  const openclawConfigPath = resolveOpenclawConfigPath(openclawDir);
  try {
    const openclawConfig = await readJsonFile(openclawConfigPath);
    if (!isRecord(openclawConfig)) {
      throw new Error("root");
    }
    const hooks = isRecord(openclawConfig.hooks) ? openclawConfig.hooks : {};
    const mappings = Array.isArray(hooks.mappings)
      ? hooks.mappings.filter(isRecord)
      : [];
    const relayMapping = mappings.find((mapping) =>
      isRelayHookMapping(mapping),
    );
    if (relayMapping === undefined || !hasRelayTransformModule(relayMapping)) {
      checks.push(
        toDoctorCheck({
          id: "state.hookMapping",
          label: "OpenClaw hook mapping",
          status: "fail",
          message: `missing send-to-peer mapping in ${openclawConfigPath}`,
          remediationHint:
            "Run: clawdentity openclaw setup <agentName> --invite-code <code>",
          details: { openclawConfigPath },
        }),
      );
    } else {
      checks.push(
        toDoctorCheck({
          id: "state.hookMapping",
          label: "OpenClaw hook mapping",
          status: "pass",
          message: "send-to-peer mapping is configured",
          details: { openclawConfigPath },
        }),
      );
    }
  } catch {
    checks.push(
      toDoctorCheck({
        id: "state.hookMapping",
        label: "OpenClaw hook mapping",
        status: "fail",
        message: `unable to read ${openclawConfigPath}`,
        remediationHint:
          "Ensure ~/.openclaw/openclaw.json exists and rerun openclaw setup",
        details: { openclawConfigPath },
      }),
    );
  }

  const relayRuntimeConfigPath = resolveRelayRuntimeConfigPath(homeDir);
  try {
    const openclawBaseUrl = await resolveOpenclawBaseUrl({
      relayRuntimeConfigPath,
    });
    checks.push(
      toDoctorCheck({
        id: "state.openclawBaseUrl",
        label: "OpenClaw base URL",
        status: "pass",
        message: `resolved to ${openclawBaseUrl}`,
      }),
    );
  } catch {
    checks.push(
      toDoctorCheck({
        id: "state.openclawBaseUrl",
        label: "OpenClaw base URL",
        status: "fail",
        message: `unable to resolve OpenClaw base URL from ${relayRuntimeConfigPath}`,
        remediationHint:
          "Run: clawdentity openclaw setup <agentName> --invite-code <code> --openclaw-base-url <url>",
      }),
    );
  }

  return toDoctorResult(checks);
}

function parseRelayProbeFailure(input: {
  status: number;
  responseBody: string;
}): Pick<OpenclawRelayTestResult, "message" | "remediationHint"> {
  if (input.status === 401 || input.status === 403) {
    return {
      message: "OpenClaw hook token was rejected",
      remediationHint:
        "Pass a valid token with --hook-token or set OPENCLAW_HOOK_TOKEN",
    };
  }

  if (input.status === 404) {
    return {
      message: "OpenClaw send-to-peer hook is unavailable",
      remediationHint:
        "Run: clawdentity openclaw setup <agentName> --invite-code <code>",
    };
  }

  if (input.status === 500) {
    return {
      message: "Relay probe failed inside local relay pipeline",
      remediationHint:
        "Check connector runtime and peer alias; rerun clawdentity openclaw doctor --peer <alias>",
    };
  }

  return {
    message: `Relay probe failed with HTTP ${input.status}`,
    remediationHint:
      input.responseBody.trim().length > 0
        ? `Inspect response body: ${input.responseBody.trim()}`
        : "Check local OpenClaw and connector logs",
  };
}

export async function runOpenclawRelayTest(
  options: OpenclawRelayTestOptions,
): Promise<OpenclawRelayTestResult> {
  const homeDir = resolveHomeDir(options.homeDir);
  const openclawDir = resolveOpenclawDir(options.openclawDir, homeDir);
  const peerAlias = parsePeerAlias(options.peer);
  const preflight = await runOpenclawDoctor({
    homeDir,
    openclawDir,
    peerAlias,
    resolveConfigImpl: options.resolveConfigImpl,
  });
  const checkedAt = nowIso();

  const relayRuntimeConfigPath = resolveRelayRuntimeConfigPath(homeDir);
  let openclawBaseUrl = DEFAULT_OPENCLAW_BASE_URL;
  try {
    openclawBaseUrl = await resolveOpenclawBaseUrl({
      optionValue: options.openclawBaseUrl,
      relayRuntimeConfigPath,
    });
  } catch {
    return {
      status: "failure",
      checkedAt,
      peerAlias,
      endpoint: toSendToPeerEndpoint(DEFAULT_OPENCLAW_BASE_URL),
      message: "Unable to resolve OpenClaw base URL",
      remediationHint:
        "Set OPENCLAW_BASE_URL or run openclaw setup with --openclaw-base-url",
      preflight,
    };
  }

  const endpoint = toSendToPeerEndpoint(openclawBaseUrl);
  if (preflight.status === "unhealthy") {
    const firstFailure = preflight.checks.find(
      (check) => check.status === "fail",
    );
    return {
      status: "failure",
      checkedAt,
      peerAlias,
      endpoint,
      message:
        firstFailure === undefined
          ? "Preflight checks failed"
          : `Preflight failed: ${firstFailure.label}`,
      remediationHint: firstFailure?.remediationHint,
      preflight,
    };
  }

  const hookToken = resolveHookToken(options.hookToken);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return {
      status: "failure",
      checkedAt,
      peerAlias,
      endpoint,
      message: "fetch implementation is unavailable",
      remediationHint: "Run relay test in a Node runtime with fetch support",
      preflight,
    };
  }

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(hookToken === undefined ? {} : { "x-openclaw-token": hookToken }),
      },
      body: JSON.stringify({
        peer: peerAlias,
        sessionId: resolveProbeSessionId(options.sessionId),
        message: resolveProbeMessage(options.message),
      }),
    });
  } catch {
    return {
      status: "failure",
      checkedAt,
      peerAlias,
      endpoint,
      message: "Relay probe request failed",
      remediationHint: "Ensure local OpenClaw is running and reachable",
      preflight,
    };
  }

  if (response.ok) {
    return {
      status: "success",
      checkedAt,
      peerAlias,
      endpoint,
      httpStatus: response.status,
      message: "Relay probe accepted",
      preflight,
    };
  }

  const responseBody = await response.text();
  const failure = parseRelayProbeFailure({
    status: response.status,
    responseBody,
  });
  return {
    status: "failure",
    checkedAt,
    peerAlias,
    endpoint,
    httpStatus: response.status,
    message: failure.message,
    remediationHint: failure.remediationHint,
    details:
      responseBody.trim().length > 0
        ? { responseBody: responseBody.trim() }
        : undefined,
    preflight,
  };
}

export function createOpenclawInviteCode(
  options: OpenclawInviteOptions,
): OpenclawInviteResult {
  const did = parseAgentDid(options.did, "invite did");
  const proxyUrl = parseProxyUrl(options.proxyUrl);
  const peerAlias =
    options.peerAlias === undefined
      ? undefined
      : parsePeerAlias(options.peerAlias);
  const name = parseOptionalName(options.name);

  const payload = parseInvitePayload({
    v: 1,
    issuedAt: nowIso(),
    did,
    proxyUrl,
    alias: peerAlias,
    name,
  });

  const result: OpenclawInviteResult = {
    code: encodeInvitePayload(payload),
    did: payload.did,
    proxyUrl: payload.proxyUrl,
    peerAlias: payload.alias,
    name: payload.name,
  };

  return result;
}

export function decodeOpenclawInviteCode(code: string): OpenclawInvitePayload {
  return decodeInvitePayload(code);
}

export async function setupOpenclawRelayFromInvite(
  agentName: string,
  options: OpenclawSetupOptions,
): Promise<OpenclawSetupResult> {
  const normalizedAgentName = assertValidAgentName(agentName);
  const homeDir = resolveHomeDir(options.homeDir);
  const openclawDir = resolveOpenclawDir(options.openclawDir, homeDir);
  const openclawConfigPath = resolveOpenclawConfigPath(openclawDir);
  const transformSource =
    typeof options.transformSource === "string" &&
    options.transformSource.trim().length > 0
      ? options.transformSource.trim()
      : resolveDefaultTransformSource(openclawDir);
  const transformTargetPath = resolveTransformTargetPath(openclawDir);
  const relayRuntimeConfigPath = resolveRelayRuntimeConfigPath(homeDir);
  const openclawBaseUrl = await resolveOpenclawBaseUrl({
    optionValue: options.openclawBaseUrl,
    relayRuntimeConfigPath,
  });
  const invite = decodeInvitePayload(options.inviteCode);
  const peerAliasCandidate = options.peerAlias ?? invite.alias;

  if (!peerAliasCandidate) {
    throw createCliError(
      "CLI_OPENCLAW_PEER_ALIAS_REQUIRED",
      "Peer alias is required. Include alias in invite code or pass --peer-alias.",
    );
  }

  const peerAlias = parsePeerAlias(peerAliasCandidate);

  await ensureLocalAgentCredentials(homeDir, normalizedAgentName);
  await mkdir(dirname(transformTargetPath), { recursive: true });
  try {
    await copyFile(transformSource, transformTargetPath);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      throw createCliError(
        "CLI_OPENCLAW_TRANSFORM_NOT_FOUND",
        "Relay transform source file was not found",
        { transformSource },
      );
    }

    throw error;
  }

  await patchOpenclawConfig(openclawConfigPath);

  const peersPath = resolvePeersPath(homeDir);
  const peers = await loadPeersConfig(peersPath);
  peers.peers[peerAlias] =
    invite.name === undefined
      ? { did: invite.did, proxyUrl: invite.proxyUrl }
      : { did: invite.did, proxyUrl: invite.proxyUrl, name: invite.name };
  await savePeersConfig(peersPath, peers);

  const agentNamePath = resolveOpenclawAgentNamePath(homeDir);
  await writeSecureFile(agentNamePath, `${normalizedAgentName}\n`);
  await saveRelayRuntimeConfig(relayRuntimeConfigPath, openclawBaseUrl);

  logger.info("cli.openclaw_setup_completed", {
    agentName: normalizedAgentName,
    peerAlias,
    peerDid: invite.did,
    openclawConfigPath,
    transformTargetPath,
    openclawBaseUrl,
    relayRuntimeConfigPath,
  });

  return {
    peerAlias,
    peerDid: invite.did,
    peerProxyUrl: invite.proxyUrl,
    openclawConfigPath,
    transformTargetPath,
    openclawBaseUrl,
    relayRuntimeConfigPath,
  };
}

export const createOpenclawCommand = (): Command => {
  const openclawCommand = new Command("openclaw").description(
    "Manage OpenClaw invite codes and relay setup",
  );

  openclawCommand
    .command("invite")
    .description("Create an invite code for peer relay onboarding")
    .requiredOption("--did <did>", "Peer agent DID (did:claw:agent:...)")
    .requiredOption(
      "--proxy-url <url>",
      "Public proxy URL ending in /hooks/agent",
    )
    .option("--peer-alias <alias>", "Suggested peer alias for the receiver")
    .option("--name <displayName>", "Human-friendly peer display name")
    .action(
      withErrorHandling(
        "openclaw invite",
        async (options: OpenclawInviteOptions) => {
          const invite = createOpenclawInviteCode(options);

          writeStdoutLine(`Invite code: ${invite.code}`);
          writeStdoutLine(`Agent DID: ${invite.did}`);
          writeStdoutLine(`Proxy URL: ${invite.proxyUrl}`);
          if (invite.peerAlias) {
            writeStdoutLine(`Suggested Alias: ${invite.peerAlias}`);
          }
        },
      ),
    );

  openclawCommand
    .command("setup <agentName>")
    .description("Apply OpenClaw relay setup using an invite code")
    .requiredOption(
      "--invite-code <code>",
      "Invite code shared by peer operator",
    )
    .option("--peer-alias <alias>", "Override peer alias for local routing")
    .option(
      "--openclaw-dir <path>",
      "OpenClaw state directory (default ~/.openclaw)",
    )
    .option(
      "--transform-source <path>",
      "Path to relay-to-peer.mjs (default <openclaw-dir>/workspace/skills/clawdentity-openclaw-relay/relay-to-peer.mjs)",
    )
    .option(
      "--openclaw-base-url <url>",
      "Base URL for local OpenClaw hook API (default http://127.0.0.1:18789)",
    )
    .action(
      withErrorHandling(
        "openclaw setup",
        async (agentName: string, options: OpenclawSetupOptions) => {
          const result = await setupOpenclawRelayFromInvite(agentName, options);
          writeStdoutLine(`Peer alias configured: ${result.peerAlias}`);
          writeStdoutLine(`Peer DID: ${result.peerDid}`);
          writeStdoutLine(`Peer proxy URL: ${result.peerProxyUrl}`);
          writeStdoutLine(
            `Updated OpenClaw config: ${result.openclawConfigPath}`,
          );
          writeStdoutLine(`Installed transform: ${result.transformTargetPath}`);
          writeStdoutLine(`OpenClaw base URL: ${result.openclawBaseUrl}`);
          writeStdoutLine(
            `Relay runtime config: ${result.relayRuntimeConfigPath}`,
          );
        },
      ),
    );

  openclawCommand
    .command("doctor")
    .description("Validate local OpenClaw relay setup and print remediation")
    .option("--peer <alias>", "Validate that a specific peer alias exists")
    .option(
      "--openclaw-dir <path>",
      "OpenClaw state directory (default ~/.openclaw)",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      withErrorHandling(
        "openclaw doctor",
        async (options: OpenclawDoctorOptions) => {
          const result = await runOpenclawDoctor(options);
          if (options.json) {
            writeStdoutLine(JSON.stringify(result, null, 2));
          } else {
            printDoctorResult(result);
          }

          if (result.status === "unhealthy") {
            process.exitCode = 1;
          }
        },
      ),
    );

  const relayCommand = openclawCommand
    .command("relay")
    .description("Run OpenClaw relay diagnostics");

  relayCommand
    .command("test")
    .description("Send a relay probe to a configured peer alias")
    .requiredOption("--peer <alias>", "Peer alias in ~/.clawdentity/peers.json")
    .option(
      "--openclaw-base-url <url>",
      "Base URL for local OpenClaw hook API (default OPENCLAW_BASE_URL or relay runtime config)",
    )
    .option(
      "--hook-token <token>",
      "OpenClaw hook token (default OPENCLAW_HOOK_TOKEN)",
    )
    .option("--session-id <id>", "Session id for the probe payload")
    .option("--message <text>", "Probe message body")
    .option(
      "--openclaw-dir <path>",
      "OpenClaw state directory (default ~/.openclaw)",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      withErrorHandling(
        "openclaw relay test",
        async (options: OpenclawRelayTestOptions) => {
          const result = await runOpenclawRelayTest(options);

          if (options.json) {
            writeStdoutLine(JSON.stringify(result, null, 2));
          } else {
            printRelayTestResult(result);
            if (
              result.preflight !== undefined &&
              result.preflight.status === "unhealthy"
            ) {
              writeStdoutLine("Preflight details:");
              for (const check of result.preflight.checks) {
                if (check.status === "fail") {
                  writeStdoutLine(formatDoctorCheckLine(check));
                  if (check.remediationHint) {
                    writeStdoutLine(`Fix: ${check.remediationHint}`);
                  }
                }
              }
            }
          }

          if (result.status === "failure") {
            process.exitCode = 1;
          }
        },
      ),
    );

  return openclawCommand;
};
