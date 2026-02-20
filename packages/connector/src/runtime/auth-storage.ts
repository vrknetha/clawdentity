import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentAuthBundle, Logger } from "@clawdentity/sdk";
import { nowUtcMs } from "@clawdentity/sdk";
import { AGENTS_DIR_NAME, REGISTRY_AUTH_FILENAME } from "./constants.js";
import { sanitizeErrorReason } from "./errors.js";
import { isRecord, parseRequiredString } from "./parse.js";
import type { ConnectorRuntimeCredentials } from "./types.js";

export function toInitialAuthBundle(
  credentials: ConnectorRuntimeCredentials,
): AgentAuthBundle {
  return {
    tokenType: "Bearer",
    accessToken: credentials.accessToken?.trim() || "",
    accessExpiresAt:
      credentials.accessExpiresAt?.trim() || "1970-01-01T00:00:00.000Z",
    refreshToken: parseRequiredString(credentials.refreshToken, "refreshToken"),
    refreshExpiresAt:
      credentials.refreshExpiresAt?.trim() || "2100-01-01T00:00:00.000Z",
  };
}

export async function writeRegistryAuthAtomic(input: {
  auth: AgentAuthBundle;
  configDir: string;
  agentName: string;
}): Promise<void> {
  const targetPath = join(
    input.configDir,
    AGENTS_DIR_NAME,
    input.agentName,
    REGISTRY_AUTH_FILENAME,
  );
  const tmpPath = `${targetPath}.tmp-${nowUtcMs()}-${Math.random().toString(16).slice(2)}`;

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(tmpPath, `${JSON.stringify(input.auth, null, 2)}\n`, "utf8");
  await rename(tmpPath, targetPath);
}

function parseRegistryAuthFromDisk(
  payload: unknown,
): AgentAuthBundle | undefined {
  if (!isRecord(payload)) {
    return undefined;
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
    return undefined;
  }

  return {
    tokenType,
    accessToken,
    accessExpiresAt,
    refreshToken,
    refreshExpiresAt,
  };
}

export async function readRegistryAuthFromDisk(input: {
  configDir: string;
  agentName: string;
  logger: Logger;
}): Promise<AgentAuthBundle | undefined> {
  const authPath = join(
    input.configDir,
    AGENTS_DIR_NAME,
    input.agentName,
    REGISTRY_AUTH_FILENAME,
  );

  let raw: string;
  try {
    raw = await readFile(authPath, "utf8");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return undefined;
    }

    input.logger.warn("connector.runtime.registry_auth_read_failed", {
      authPath,
      reason: sanitizeErrorReason(error),
    });
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    input.logger.warn("connector.runtime.registry_auth_invalid_json", {
      authPath,
    });
    return undefined;
  }

  const auth = parseRegistryAuthFromDisk(parsed);
  if (auth === undefined) {
    input.logger.warn("connector.runtime.registry_auth_invalid_shape", {
      authPath,
    });
  }
  return auth;
}
