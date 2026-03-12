import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getConfigDir } from "../../config/manager.js";
import {
  createCliError,
  derivePeerAliasBase,
  FILE_MODE,
  logger,
  OPENCLAW_RELAY_RUNTIME_FILE_NAME,
  PEERS_FILE_NAME,
  parseNonEmptyString,
  parsePeerAlias,
  parsePeerEntry,
  resolvePeerProxyUrl,
} from "./common.js";
import type {
  PairRequestOptions,
  PeerEntry,
  PeerProfile,
  PeersConfig,
} from "./types.js";

function resolvePeersConfigPath(getConfigDirImpl: typeof getConfigDir): string {
  return join(getConfigDirImpl(), PEERS_FILE_NAME);
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

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw createCliError(
      "CLI_PAIR_PEERS_CONFIG_INVALID",
      "Peer config must be a JSON object",
    );
  }

  const parsedRecord = parsed as Record<string, unknown>;
  if (parsedRecord.peers === undefined) {
    return { peers: {} };
  }

  if (
    typeof parsedRecord.peers !== "object" ||
    parsedRecord.peers === null ||
    Array.isArray(parsedRecord.peers)
  ) {
    throw createCliError(
      "CLI_PAIR_PEERS_CONFIG_INVALID",
      "Peer config peers field must be an object",
    );
  }

  const peers: Record<string, PeerEntry> = {};
  for (const [alias, value] of Object.entries(parsedRecord.peers)) {
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

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const relayTransformPeersPath = parseNonEmptyString(
    (parsed as Record<string, unknown>).relayTransformPeersPath,
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

export async function persistPairedPeer(input: {
  ticket: string;
  peerDid: string;
  peerProfile: PeerProfile;
  peerProxyOrigin?: string;
  dependencies: PairRequestOptions;
}): Promise<string> {
  const getConfigDirImpl = input.dependencies.getConfigDirImpl ?? getConfigDir;
  const readFileImpl = input.dependencies.readFileImpl ?? readFile;
  const mkdirImpl = input.dependencies.mkdirImpl ?? mkdir;
  const writeFileImpl = input.dependencies.writeFileImpl ?? writeFile;
  const chmodImpl = input.dependencies.chmodImpl ?? chmod;

  const peerProxyUrl = resolvePeerProxyUrl({
    ticket: input.ticket,
    peerProfile: input.peerProfile,
    peerProxyOrigin: input.peerProxyOrigin,
  });
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
