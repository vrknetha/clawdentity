import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { decodeBase64url, encodeBase64url } from "@clawdentity/protocol";
import {
  type AgentAuthBundle,
  AppError,
  executeWithAgentAuthRefreshRetry,
  refreshAgentAuthWithClawProof,
  signHttpRequest,
} from "@clawdentity/sdk";
import {
  loadPeersConfig,
  type PeersConfigPathOptions,
} from "./peers-config.js";
import {
  readAgentRegistryAuth,
  withAgentRegistryAuthLock,
  writeAgentRegistryAuthAtomic,
} from "./registry-auth.js";

const CLAWDENTITY_DIR = ".clawdentity";
const AGENTS_DIR = "agents";
const SECRET_KEY_FILENAME = "secret.key";
const AIT_FILENAME = "ait.jwt";
const IDENTITY_FILENAME = "identity.json";
const AGENT_NAME_ENV = "CLAWDENTITY_AGENT_NAME";
const OPENCLAW_AGENT_NAME_FILENAME = "openclaw-agent-name";
const NONCE_SIZE = 16;
const AGENT_ACCESS_HEADER = "x-claw-agent-access";

const textEncoder = new TextEncoder();

export type RelayToPeerOptions = PeersConfigPathOptions & {
  agentName?: string;
  fetchImpl?: typeof fetch;
  clock?: () => number;
  randomBytesImpl?: (size: number) => Uint8Array;
};

export type RelayTransformContext = {
  payload?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  return typeof error.code === "string" ? error.code : undefined;
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

function parseIdentityRegistryUrl(
  payload: unknown,
  options: { agentName: string },
): string {
  if (!isRecord(payload) || typeof payload.registryUrl !== "string") {
    throw new Error(
      `Agent "${options.agentName}" has invalid ${IDENTITY_FILENAME} (missing registryUrl)`,
    );
  }

  const registryUrl = payload.registryUrl.trim();
  if (registryUrl.length === 0) {
    throw new Error(
      `Agent "${options.agentName}" has invalid ${IDENTITY_FILENAME} (missing registryUrl)`,
    );
  }

  return registryUrl;
}

function resolvePathWithQuery(url: URL): string {
  return `${url.pathname}${url.search}`;
}

function resolveRelayFetch(fetchImpl?: typeof fetch): typeof fetch {
  const resolved = fetchImpl ?? globalThis.fetch;
  if (typeof resolved !== "function") {
    throw new Error("fetch implementation is required");
  }

  return resolved;
}

async function tryReadTrimmedFile(
  filePath: string,
  _label: string,
): Promise<string | undefined> {
  let raw: string;

  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return undefined;
    }

    throw error;
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error("Required file content is empty");
  }

  return trimmed;
}

async function readTrimmedFile(
  filePath: string,
  label: string,
): Promise<string> {
  const content = await tryReadTrimmedFile(filePath, label);
  if (content === undefined) {
    throw new Error("Required file is missing");
  }

  return content;
}

async function resolveAgentName(input: {
  overrideName?: string;
  homeDir: string;
}): Promise<string> {
  const overridden = input.overrideName?.trim();
  if (overridden) {
    return overridden;
  }

  const envAgentName = process.env[AGENT_NAME_ENV]?.trim();
  if (envAgentName) {
    return envAgentName;
  }

  const selectedAgentPath = join(
    input.homeDir,
    CLAWDENTITY_DIR,
    OPENCLAW_AGENT_NAME_FILENAME,
  );
  const selectedAgentName = await tryReadTrimmedFile(
    selectedAgentPath,
    OPENCLAW_AGENT_NAME_FILENAME,
  );
  if (selectedAgentName) {
    return selectedAgentName;
  }

  const agentsDirectory = join(input.homeDir, CLAWDENTITY_DIR, AGENTS_DIR);
  let entries: Array<{ isDirectory: () => boolean; name: string }>;
  try {
    entries = (await readdir(agentsDirectory, {
      withFileTypes: true,
    })) as Array<{ isDirectory: () => boolean; name: string }>;
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      throw new Error("No local agents found. Select one before relay setup.");
    }

    throw error;
  }

  const agentNames = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  if (agentNames.length === 1) {
    return agentNames[0];
  }

  if (agentNames.length === 0) {
    throw new Error("No local agents found. Select one before relay setup.");
  }

  throw new Error(
    "Multiple local agents found. Configure a selected relay agent first.",
  );
}

async function readAgentCredentials(input: {
  agentName: string;
  homeDir: string;
}): Promise<{ ait: string; secretKey: Uint8Array; registryUrl: string }> {
  const agentDir = join(
    input.homeDir,
    CLAWDENTITY_DIR,
    AGENTS_DIR,
    input.agentName,
  );
  const secretPath = join(agentDir, SECRET_KEY_FILENAME);
  const aitPath = join(agentDir, AIT_FILENAME);
  const identityPath = join(agentDir, IDENTITY_FILENAME);

  const [encodedSecret, ait, rawIdentity] = await Promise.all([
    readTrimmedFile(secretPath, SECRET_KEY_FILENAME),
    readTrimmedFile(aitPath, AIT_FILENAME),
    readTrimmedFile(identityPath, IDENTITY_FILENAME),
  ]);

  let secretKey: Uint8Array;
  try {
    secretKey = decodeBase64url(encodedSecret);
  } catch {
    throw new Error("Agent secret key is invalid");
  }

  let parsedIdentity: unknown;
  try {
    parsedIdentity = JSON.parse(rawIdentity);
  } catch {
    throw new Error(
      `Agent "${input.agentName}" has invalid ${IDENTITY_FILENAME} (must be valid JSON)`,
    );
  }
  const registryUrl = parseIdentityRegistryUrl(parsedIdentity, {
    agentName: input.agentName,
  });

  return {
    ait,
    secretKey,
    registryUrl,
  };
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

function isRetryableRelayAuthError(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.code === "OPENCLAW_RELAY_AGENT_AUTH_REJECTED" &&
    error.status === 401
  );
}

function buildRefreshSingleFlightKey(input: {
  homeDir: string;
  agentName: string;
}): string {
  return `${input.homeDir}:${input.agentName}`;
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

  const home =
    typeof options.homeDir === "string" && options.homeDir.trim().length > 0
      ? options.homeDir.trim()
      : homedir();
  const agentName = await resolveAgentName({
    overrideName: options.agentName,
    homeDir: home,
  });
  const { ait, secretKey, registryUrl } = await readAgentCredentials({
    agentName,
    homeDir: home,
  });

  const outboundPayload = removePeerField(payload);
  const body = JSON.stringify(outboundPayload);
  const peerUrl = new URL(peerEntry.proxyUrl);
  const fetchImpl = resolveRelayFetch(options.fetchImpl);
  const refreshSingleFlightKey = buildRefreshSingleFlightKey({
    homeDir: home,
    agentName,
  });

  const sendRelayRequest = async (auth: AgentAuthBundle): Promise<Response> => {
    const unixSeconds = Math.floor(
      (options.clock ?? Date.now)() / 1000,
    ).toString();
    const nonce = encodeBase64url(
      (options.randomBytesImpl ?? randomBytes)(NONCE_SIZE),
    );
    const signed = await signHttpRequest({
      method: "POST",
      pathWithQuery: resolvePathWithQuery(peerUrl),
      timestamp: unixSeconds,
      nonce,
      body: textEncoder.encode(body),
      secretKey,
    });

    return fetchImpl(peerUrl.toString(), {
      method: "POST",
      headers: {
        Authorization: `Claw ${ait}`,
        "Content-Type": "application/json",
        [AGENT_ACCESS_HEADER]: auth.accessToken,
        ...signed.headers,
      },
      body,
    });
  };

  const performRelay = async (auth: AgentAuthBundle): Promise<null> => {
    const response = await sendRelayRequest(auth);
    if (!response.ok) {
      if (response.status === 401) {
        throw new AppError({
          code: "OPENCLAW_RELAY_AGENT_AUTH_REJECTED",
          message: "Peer relay rejected agent auth credentials",
          status: 401,
          expose: true,
        });
      }

      throw new Error("Peer relay request failed");
    }

    return null;
  };

  const result = await executeWithAgentAuthRefreshRetry({
    key: refreshSingleFlightKey,
    shouldRetry: isRetryableRelayAuthError,
    getAuth: async () =>
      readAgentRegistryAuth({
        homeDir: home,
        agentName,
      }),
    persistAuth: async () => {},
    refreshAuth: async (currentAuth) =>
      withAgentRegistryAuthLock({
        homeDir: home,
        agentName,
        operation: async () => {
          const latestAuth = await readAgentRegistryAuth({
            homeDir: home,
            agentName,
          });
          if (latestAuth.refreshToken !== currentAuth.refreshToken) {
            return latestAuth;
          }

          let refreshedAuth: AgentAuthBundle;
          try {
            refreshedAuth = await refreshAgentAuthWithClawProof({
              registryUrl,
              ait,
              secretKey,
              refreshToken: latestAuth.refreshToken,
              fetchImpl,
            });
          } catch (error) {
            const afterFailureAuth = await readAgentRegistryAuth({
              homeDir: home,
              agentName,
            });
            if (afterFailureAuth.refreshToken !== latestAuth.refreshToken) {
              return afterFailureAuth;
            }

            throw error;
          }
          await writeAgentRegistryAuthAtomic({
            homeDir: home,
            agentName,
            auth: refreshedAuth,
          });

          return refreshedAuth;
        },
      }),
    perform: performRelay,
  });

  return result;
}

export default async function relayToPeer(
  ctx: RelayTransformContext,
): Promise<unknown | null> {
  return relayPayloadToPeer(ctx?.payload);
}
