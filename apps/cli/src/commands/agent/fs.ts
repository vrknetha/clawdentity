import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { decodeBase64url } from "@clawdentity/protocol";
import { nowUtcMs } from "@clawdentity/sdk";
import {
  AIT_FILE_NAME,
  FILE_MODE,
  getAgentAitPath,
  getAgentIdentityPath,
  getAgentRegistryAuthPath,
  getAgentSecretKeyPath,
  getAgentsDirectory,
  IDENTITY_FILE_NAME,
  PUBLIC_KEY_FILE_NAME,
  REGISTRY_AUTH_FILE_NAME,
  SECRET_KEY_FILE_NAME,
} from "./paths.js";
import type {
  AgentAuthBundle,
  LocalAgentIdentity,
  LocalAgentRegistryAuth,
} from "./types.js";
import { parseNonEmptyString } from "./validation.js";

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

export const readAgentAitToken = async (agentName: string): Promise<string> => {
  const aitPath = getAgentAitPath(agentName);

  let rawToken: string;
  try {
    rawToken = await readFile(aitPath, "utf-8");
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      throw new Error(`Agent "${agentName}" not found (${aitPath})`);
    }

    throw error;
  }

  const token = rawToken.trim();
  if (token.length === 0) {
    throw new Error(`Agent "${agentName}" has an empty ${AIT_FILE_NAME}`);
  }

  return token;
};

export const readAgentIdentity = async (
  agentName: string,
): Promise<LocalAgentIdentity> => {
  const identityPath = getAgentIdentityPath(agentName);

  let rawIdentity: string;
  try {
    rawIdentity = await readFile(identityPath, "utf-8");
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      throw new Error(`Agent "${agentName}" not found (${identityPath})`);
    }

    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawIdentity);
  } catch {
    throw new Error(
      `Agent "${agentName}" has invalid ${IDENTITY_FILE_NAME} (must be valid JSON)`,
    );
  }

  if (!isRecord(parsed) || typeof parsed.did !== "string") {
    throw new Error(
      `Agent "${agentName}" has invalid ${IDENTITY_FILE_NAME} (missing did)`,
    );
  }

  const did = parsed.did.trim();
  if (did.length === 0) {
    throw new Error(
      `Agent "${agentName}" has invalid ${IDENTITY_FILE_NAME} (missing did)`,
    );
  }

  const registryUrl = parseNonEmptyString(parsed.registryUrl);
  return {
    did,
    registryUrl: registryUrl.length > 0 ? registryUrl : undefined,
  };
};

export const readAgentSecretKey = async (
  agentName: string,
): Promise<Uint8Array> => {
  const secretKeyPath = getAgentSecretKeyPath(agentName);

  let rawSecretKey: string;
  try {
    rawSecretKey = await readFile(secretKeyPath, "utf-8");
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      throw new Error(`Agent "${agentName}" not found (${secretKeyPath})`);
    }
    throw error;
  }

  const encodedSecretKey = rawSecretKey.trim();
  if (encodedSecretKey.length === 0) {
    throw new Error(
      `Agent "${agentName}" has an empty ${SECRET_KEY_FILE_NAME}`,
    );
  }

  try {
    return decodeBase64url(encodedSecretKey);
  } catch {
    throw new Error(
      `Agent "${agentName}" has invalid ${SECRET_KEY_FILE_NAME} format`,
    );
  }
};

export const readAgentRegistryAuth = async (
  agentName: string,
): Promise<LocalAgentRegistryAuth> => {
  const registryAuthPath = getAgentRegistryAuthPath(agentName);

  let rawRegistryAuth: string;
  try {
    rawRegistryAuth = await readFile(registryAuthPath, "utf-8");
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      throw new Error(
        `Agent "${agentName}" has no ${REGISTRY_AUTH_FILE_NAME}. Recreate agent identity or re-run auth bootstrap.`,
      );
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawRegistryAuth);
  } catch {
    throw new Error(
      `Agent "${agentName}" has invalid ${REGISTRY_AUTH_FILE_NAME} (must be valid JSON)`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error(
      `Agent "${agentName}" has invalid ${REGISTRY_AUTH_FILE_NAME}`,
    );
  }

  const refreshToken = parseNonEmptyString(parsed.refreshToken);
  if (refreshToken.length === 0) {
    throw new Error(
      `Agent "${agentName}" has invalid ${REGISTRY_AUTH_FILE_NAME} (missing refreshToken)`,
    );
  }

  return {
    refreshToken,
  };
};

export const ensureAgentDirectoryAvailable = async (
  agentName: string,
  agentDirectory: string,
): Promise<void> => {
  try {
    await access(agentDirectory);
    throw new Error(`Agent "${agentName}" already exists at ${agentDirectory}`);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return;
    }

    throw error;
  }
};

const writeSecureFile = async (
  path: string,
  content: string,
): Promise<void> => {
  await writeFile(path, content, "utf-8");
  await chmod(path, FILE_MODE);
};

const writeSecureFileAtomically = async (
  path: string,
  content: string,
): Promise<void> => {
  const tempPath = `${path}.tmp-${nowUtcMs()}-${Math.random().toString(16).slice(2)}`;

  await writeFile(tempPath, content, "utf-8");
  await chmod(tempPath, FILE_MODE);

  try {
    await rename(tempPath, path);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch {
      // Best-effort cleanup only.
    }

    throw error;
  }
};

const ensureAgentDirectory = async (
  agentName: string,
  agentDirectory: string,
): Promise<void> => {
  await mkdir(getAgentsDirectory(), { recursive: true });

  try {
    await mkdir(agentDirectory);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "EEXIST") {
      throw new Error(
        `Agent "${agentName}" already exists at ${agentDirectory}`,
      );
    }

    throw error;
  }
};

export const writeAgentIdentity = async (input: {
  agentDirectory: string;
  did: string;
  name: string;
  framework: string;
  expiresAt: string;
  registryUrl: string;
  publicKey: string;
  secretKey: string;
  ait: string;
  agentAuth: AgentAuthBundle;
}): Promise<void> => {
  await ensureAgentDirectory(input.name, input.agentDirectory);

  const identityJson = {
    did: input.did,
    name: input.name,
    framework: input.framework,
    expiresAt: input.expiresAt,
    registryUrl: input.registryUrl,
  };

  await writeSecureFile(
    join(input.agentDirectory, SECRET_KEY_FILE_NAME),
    input.secretKey,
  );
  await writeSecureFile(
    join(input.agentDirectory, PUBLIC_KEY_FILE_NAME),
    input.publicKey,
  );
  await writeSecureFile(
    join(input.agentDirectory, IDENTITY_FILE_NAME),
    `${JSON.stringify(identityJson, null, 2)}\n`,
  );
  await writeSecureFile(join(input.agentDirectory, AIT_FILE_NAME), input.ait);
  await writeSecureFile(
    join(input.agentDirectory, REGISTRY_AUTH_FILE_NAME),
    `${JSON.stringify(input.agentAuth, null, 2)}\n`,
  );
};

export const writeAgentRegistryAuth = async (input: {
  agentName: string;
  agentAuth: AgentAuthBundle;
}): Promise<void> => {
  await writeSecureFileAtomically(
    getAgentRegistryAuthPath(input.agentName),
    `${JSON.stringify(input.agentAuth, null, 2)}\n`,
  );
};
