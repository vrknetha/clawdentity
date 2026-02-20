import {
  chmod,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { type AgentAuthBundle, nowUtcMs } from "@clawdentity/sdk";

const CLAWDENTITY_DIR = ".clawdentity";
const AGENTS_DIR = "agents";
const REGISTRY_AUTH_FILENAME = "registry-auth.json";
const FILE_MODE = 0o600;
const LOCK_RETRY_DELAY_MS = 50;
const LOCK_MAX_ATTEMPTS = 200;
const STALE_LOCK_AGE_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  return typeof error.code === "string" ? error.code : undefined;
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function parseAgentAuthBundle(
  payload: unknown,
  options: { agentName: string },
): AgentAuthBundle {
  if (!isRecord(payload)) {
    throw new Error(
      `Agent "${options.agentName}" has invalid ${REGISTRY_AUTH_FILENAME}`,
    );
  }

  const tokenType = payload.tokenType;
  const accessToken = payload.accessToken;
  const accessExpiresAt = payload.accessExpiresAt;
  const refreshToken = payload.refreshToken;
  const refreshExpiresAt = payload.refreshExpiresAt;

  if (
    tokenType !== "Bearer" ||
    typeof accessToken !== "string" ||
    typeof accessExpiresAt !== "string" ||
    typeof refreshToken !== "string" ||
    typeof refreshExpiresAt !== "string"
  ) {
    throw new Error(
      `Agent "${options.agentName}" has invalid ${REGISTRY_AUTH_FILENAME}`,
    );
  }

  return {
    tokenType,
    accessToken,
    accessExpiresAt,
    refreshToken,
    refreshExpiresAt,
  };
}

export function resolveAgentRegistryAuthPath(input: {
  homeDir: string;
  agentName: string;
}): string {
  return join(
    input.homeDir,
    CLAWDENTITY_DIR,
    AGENTS_DIR,
    input.agentName,
    REGISTRY_AUTH_FILENAME,
  );
}

export async function readAgentRegistryAuth(input: {
  homeDir: string;
  agentName: string;
}): Promise<AgentAuthBundle> {
  const registryAuthPath = resolveAgentRegistryAuthPath(input);
  let rawRegistryAuth: string;
  try {
    rawRegistryAuth = await readFile(registryAuthPath, "utf8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      throw new Error(
        `Agent "${input.agentName}" has no ${REGISTRY_AUTH_FILENAME}. Recreate agent identity or re-run auth bootstrap.`,
      );
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawRegistryAuth);
  } catch {
    throw new Error(
      `Agent "${input.agentName}" has invalid ${REGISTRY_AUTH_FILENAME} (must be valid JSON)`,
    );
  }

  return parseAgentAuthBundle(parsed, { agentName: input.agentName });
}

export async function writeAgentRegistryAuthAtomic(input: {
  homeDir: string;
  agentName: string;
  auth: AgentAuthBundle;
}): Promise<void> {
  const registryAuthPath = resolveAgentRegistryAuthPath(input);
  const tempPath = `${registryAuthPath}.tmp-${nowUtcMs()}-${Math.random().toString(16).slice(2)}`;
  const content = `${JSON.stringify(input.auth, null, 2)}\n`;

  await writeFile(tempPath, content, "utf8");
  await chmod(tempPath, FILE_MODE);

  try {
    await rename(tempPath, registryAuthPath);
    await chmod(registryAuthPath, FILE_MODE);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch {
      // Best-effort cleanup.
    }
    throw error;
  }
}

export async function withAgentRegistryAuthLock<T>(input: {
  homeDir: string;
  agentName: string;
  operation: () => Promise<T>;
}): Promise<T> {
  const registryAuthPath = resolveAgentRegistryAuthPath(input);
  const lockPath = `${registryAuthPath}.lock`;
  let lockAcquired = false;

  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt += 1) {
    try {
      const lockHandle = await open(lockPath, "wx", FILE_MODE);
      await lockHandle.writeFile(`${nowUtcMs()}`);
      await lockHandle.close();
      lockAcquired = true;
      break;
    } catch (error) {
      if (getErrorCode(error) !== "EEXIST") {
        throw error;
      }

      try {
        const lockStat = await stat(lockPath);
        if (nowUtcMs() - lockStat.mtimeMs > STALE_LOCK_AGE_MS) {
          await unlink(lockPath);
          continue;
        }
      } catch (statError) {
        if (getErrorCode(statError) !== "ENOENT") {
          throw statError;
        }
      }

      await sleep(LOCK_RETRY_DELAY_MS);
    }
  }

  if (!lockAcquired) {
    throw new Error(
      `Timed out waiting for ${REGISTRY_AUTH_FILENAME} lock for agent "${input.agentName}"`,
    );
  }

  try {
    return await input.operation();
  } finally {
    try {
      await unlink(lockPath);
    } catch {
      // Best-effort cleanup.
    }
  }
}
