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
import { writeStdoutLine } from "../io.js";
import { assertValidAgentName } from "./agent-name.js";
import { withErrorHandling } from "./helpers.js";

const logger = createLogger({ service: "cli", module: "openclaw" });

const AGENTS_DIR_NAME = "agents";
const AIT_FILE_NAME = "ait.jwt";
const SECRET_KEY_FILE_NAME = "secret.key";
const PEERS_FILE_NAME = "peers.json";
const OPENCLAW_DIR_NAME = ".openclaw";
const OPENCLAW_CONFIG_FILE_NAME = "openclaw.json";
const OPENCLAW_AGENT_FILE_NAME = "openclaw-agent-name";
const SKILL_DIR_NAME = "clawdentity-openclaw-relay";
const RELAY_MODULE_FILE_NAME = "relay-to-peer.mjs";
const HOOK_MAPPING_ID = "clawdentity-send-to-peer";
const HOOK_PATH_SEND_TO_PEER = "send-to-peer";
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
  homeDir?: string;
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
  const candidate = parseNonEmptyString(value, "proxy URL");

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(candidate);
  } catch {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_PROXY_URL",
      "proxy URL must be a valid URL",
    );
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_PROXY_URL",
      "proxy URL must use http or https",
    );
  }

  return parsedUrl.toString();
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
  return join(homeDir, ".clawdentity", AGENTS_DIR_NAME, agentName);
}

function resolvePeersPath(homeDir: string): string {
  return join(homeDir, ".clawdentity", PEERS_FILE_NAME);
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
  return join(homeDir, ".clawdentity", OPENCLAW_AGENT_FILE_NAME);
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
  hooks.allowRequestSessionKey = true;
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

  logger.info("cli.openclaw_setup_completed", {
    agentName: normalizedAgentName,
    peerAlias,
    peerDid: invite.did,
    openclawConfigPath,
    transformTargetPath,
  });

  return {
    peerAlias,
    peerDid: invite.did,
    peerProxyUrl: invite.proxyUrl,
    openclawConfigPath,
    transformTargetPath,
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
        },
      ),
    );

  return openclawCommand;
};
