import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { nowIso } from "@clawdentity/sdk";
import { assertValidAgentName } from "../agent-name.js";
import {
  createCliError,
  getErrorCode,
  isRecord,
  parseAgentDid,
  parseHttpUrl,
  parseOpenclawBaseUrl,
  parseOptionalProfileName,
  parsePeerAlias,
  parseProxyUrl,
} from "./common.js";
import {
  AIT_FILE_NAME,
  DEFAULT_OPENCLAW_BASE_URL,
  FILE_MODE,
  SECRET_KEY_FILE_NAME,
} from "./constants.js";
import { resolveAgentDirectory } from "./paths.js";
import type {
  ConnectorAssignmentEntry,
  ConnectorAssignmentsConfig,
  OpenclawRelayRuntimeConfig,
  PeerEntry,
  PeersConfig,
} from "./types.js";

export async function readJsonFile(filePath: string): Promise<unknown> {
  const raw = await readFile(filePath, "utf8");

  try {
    return JSON.parse(raw);
  } catch {
    throw createCliError("CLI_OPENCLAW_INVALID_JSON", "JSON file is invalid", {
      filePath,
    });
  }
}

export async function writeSecureFile(
  filePath: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  await chmod(filePath, FILE_MODE);
}

export async function ensureLocalAgentCredentials(
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

export async function loadPeersConfig(peersPath: string): Promise<PeersConfig> {
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
    const agentName = parseOptionalProfileName(value.agentName, "agentName");
    const humanName = parseOptionalProfileName(value.humanName, "humanName");

    if (agentName === undefined && humanName === undefined) {
      peers[normalizedAlias] = { did, proxyUrl };
      continue;
    }

    peers[normalizedAlias] = { did, proxyUrl, agentName, humanName };
  }

  return { peers };
}

export async function savePeersConfig(
  peersPath: string,
  config: PeersConfig,
): Promise<void> {
  await writeSecureFile(peersPath, `${JSON.stringify(config, null, 2)}\n`);
}

function parseConnectorBaseUrlForAssignment(
  value: unknown,
  label: string,
): string {
  return parseHttpUrl(value, {
    label,
    code: "CLI_OPENCLAW_INVALID_CONNECTOR_BASE_URL",
    message: "Connector base URL must be a valid URL",
  });
}

function parseConnectorAssignments(
  value: unknown,
  connectorAssignmentsPath: string,
): ConnectorAssignmentsConfig {
  if (!isRecord(value)) {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_CONNECTOR_ASSIGNMENTS",
      "Connector assignments config must be an object",
      { connectorAssignmentsPath },
    );
  }

  const agentsRaw = value.agents;
  if (!isRecord(agentsRaw)) {
    return { agents: {} };
  }

  const agents: Record<string, ConnectorAssignmentEntry> = {};
  for (const [agentName, entryValue] of Object.entries(agentsRaw)) {
    if (!isRecord(entryValue)) {
      throw createCliError(
        "CLI_OPENCLAW_INVALID_CONNECTOR_ASSIGNMENTS",
        "Connector assignment entry must be an object",
        { connectorAssignmentsPath, agentName },
      );
    }

    const connectorBaseUrl = parseConnectorBaseUrlForAssignment(
      entryValue.connectorBaseUrl,
      "connectorBaseUrl",
    );
    const updatedAt =
      typeof entryValue.updatedAt === "string" &&
      entryValue.updatedAt.trim().length > 0
        ? entryValue.updatedAt.trim()
        : nowIso();

    agents[assertValidAgentName(agentName)] = {
      connectorBaseUrl,
      updatedAt,
    };
  }

  return { agents };
}

export async function loadConnectorAssignments(
  connectorAssignmentsPath: string,
): Promise<ConnectorAssignmentsConfig> {
  let parsed: unknown;
  try {
    parsed = await readJsonFile(connectorAssignmentsPath);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return { agents: {} };
    }
    throw error;
  }

  return parseConnectorAssignments(parsed, connectorAssignmentsPath);
}

export async function saveConnectorAssignments(
  connectorAssignmentsPath: string,
  config: ConnectorAssignmentsConfig,
): Promise<void> {
  await writeSecureFile(
    connectorAssignmentsPath,
    `${JSON.stringify(config, null, 2)}\n`,
  );
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
  const openclawHookToken =
    typeof value.openclawHookToken === "string" &&
    value.openclawHookToken.trim().length > 0
      ? value.openclawHookToken.trim()
      : undefined;
  const relayTransformPeersPath =
    typeof value.relayTransformPeersPath === "string" &&
    value.relayTransformPeersPath.trim().length > 0
      ? value.relayTransformPeersPath.trim()
      : undefined;

  return {
    openclawBaseUrl: parseOpenclawBaseUrl(value.openclawBaseUrl),
    openclawHookToken,
    relayTransformPeersPath,
    updatedAt,
  };
}

export async function loadRelayRuntimeConfig(
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

export async function saveRelayRuntimeConfig(
  relayRuntimeConfigPath: string,
  openclawBaseUrl: string,
  openclawHookToken?: string,
  relayTransformPeersPath?: string,
): Promise<void> {
  const config: OpenclawRelayRuntimeConfig = {
    openclawBaseUrl,
    ...(openclawHookToken ? { openclawHookToken } : {}),
    ...(relayTransformPeersPath ? { relayTransformPeersPath } : {}),
    updatedAt: nowIso(),
  };

  await writeSecureFile(
    relayRuntimeConfigPath,
    `${JSON.stringify(config, null, 2)}\n`,
  );
}

export async function resolveOpenclawBaseUrl(input: {
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

export async function resolveHookToken(input: {
  optionValue?: string;
  relayRuntimeConfigPath: string;
}): Promise<string | undefined> {
  const trimmedOption = input.optionValue?.trim();
  if (trimmedOption !== undefined && trimmedOption.length > 0) {
    return trimmedOption;
  }

  const envValue = process.env.OPENCLAW_HOOK_TOKEN?.trim();
  if (envValue !== undefined && envValue.length > 0) {
    return envValue;
  }

  const existingConfig = await loadRelayRuntimeConfig(
    input.relayRuntimeConfigPath,
  );
  if (existingConfig?.openclawHookToken) {
    return existingConfig.openclawHookToken;
  }

  return undefined;
}
