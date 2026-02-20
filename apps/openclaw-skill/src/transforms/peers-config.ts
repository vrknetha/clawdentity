import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isRecord } from "@clawdentity/common";

const CLAWDENTITY_DIR = ".clawdentity";
const PEERS_FILENAME = "peers.json";
const FILE_MODE = 0o600;
const PEER_ALIAS_PATTERN = /^[a-zA-Z0-9._-]+$/;

export type PeerEntry = {
  did: string;
  proxyUrl: string;
  agentName?: string;
  humanName?: string;
};

export type PeersConfig = {
  peers: Record<string, PeerEntry>;
};

export type PeersConfigPathOptions = {
  configDir?: string;
  configPath?: string;
  homeDir?: string;
};

function getErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  return typeof error.code === "string" ? error.code : undefined;
}

function parseNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${label} must not be empty`);
  }

  return trimmed;
}

function parsePeerAlias(value: unknown): string {
  const alias = parseNonEmptyString(value, "peer alias");

  if (alias.length > 128) {
    throw new Error("peer alias must be at most 128 characters");
  }

  if (!PEER_ALIAS_PATTERN.test(alias)) {
    throw new Error(
      "peer alias must use only letters, numbers, dot, underscore, or hyphen",
    );
  }

  return alias;
}

function parseDid(value: unknown): string {
  const did = parseNonEmptyString(value, "did");
  if (!did.startsWith("did:")) {
    throw new Error("did must start with 'did:'");
  }

  return did;
}

function parseProxyUrl(value: unknown): string {
  const candidate = parseNonEmptyString(value, "proxyUrl");

  try {
    return new URL(candidate).toString();
  } catch {
    throw new Error("proxyUrl must be a valid URL");
  }
}

function parseProfileName(
  value: unknown,
  label: "agentName" | "humanName",
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return parseNonEmptyString(value, label);
}

function parsePeerEntry(value: unknown): PeerEntry {
  if (!isRecord(value)) {
    throw new Error("peer entry must be an object");
  }

  const did = parseDid(value.did);
  const proxyUrl = parseProxyUrl(value.proxyUrl);
  const agentName = parseProfileName(value.agentName, "agentName");
  const humanName = parseProfileName(value.humanName, "humanName");

  if (agentName === undefined && humanName === undefined) {
    return { did, proxyUrl };
  }

  return { did, proxyUrl, agentName, humanName };
}

function parsePeersConfig(value: unknown, source: string): PeersConfig {
  if (!isRecord(value)) {
    throw new Error(
      `Peer config validation failed at ${source}: root must be an object`,
    );
  }

  const peersRaw = value.peers;
  if (peersRaw === undefined) {
    return { peers: {} };
  }

  if (!isRecord(peersRaw)) {
    throw new Error(
      `Peer config validation failed at ${source}: peers must be an object`,
    );
  }

  const peers: Record<string, PeerEntry> = {};
  for (const [alias, peerValue] of Object.entries(peersRaw)) {
    const normalizedAlias = parsePeerAlias(alias);

    try {
      peers[normalizedAlias] = parsePeerEntry(peerValue);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Peer config validation failed at ${source}: peers.${normalizedAlias}: ${reason}`,
      );
    }
  }

  return { peers };
}

export function resolvePeersConfigPath(
  options: PeersConfigPathOptions = {},
): string {
  if (
    typeof options.configPath === "string" &&
    options.configPath.trim().length > 0
  ) {
    return options.configPath.trim();
  }

  if (
    typeof options.configDir === "string" &&
    options.configDir.trim().length > 0
  ) {
    return join(options.configDir.trim(), PEERS_FILENAME);
  }

  const home =
    typeof options.homeDir === "string" && options.homeDir.trim().length > 0
      ? options.homeDir.trim()
      : homedir();

  return join(home, CLAWDENTITY_DIR, PEERS_FILENAME);
}

export async function loadPeersConfig(
  options: PeersConfigPathOptions = {},
): Promise<PeersConfig> {
  const configPath = resolvePeersConfigPath(options);

  let rawJson: string;
  try {
    rawJson = await readFile(configPath, "utf8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return { peers: {} };
    }

    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error(`Peer config at ${configPath} is not valid JSON`);
  }

  return parsePeersConfig(parsed, configPath);
}

export async function savePeersConfig(
  config: PeersConfig,
  options: PeersConfigPathOptions = {},
): Promise<void> {
  const configPath = resolvePeersConfigPath(options);
  const parsedConfig = parsePeersConfig(config, configPath);

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify(parsedConfig, null, 2)}\n`,
    "utf8",
  );
  await chmod(configPath, FILE_MODE);
}

export async function addPeer(
  alias: string,
  entry: PeerEntry,
  options: PeersConfigPathOptions = {},
): Promise<PeersConfig> {
  const normalizedAlias = parsePeerAlias(alias);
  const normalizedEntry = parsePeerEntry(entry);
  const current = await loadPeersConfig(options);

  const next: PeersConfig = {
    peers: {
      ...current.peers,
      [normalizedAlias]: normalizedEntry,
    },
  };

  await savePeersConfig(next, options);

  return next;
}
