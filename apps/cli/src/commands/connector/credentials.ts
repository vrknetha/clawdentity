import type { ConnectorCredentials, ReadFileText } from "./types.js";
import {
  createCliError,
  getErrorCode,
  parseAgentDid,
  parseJsonRecord,
  parseNonEmptyString,
} from "./validation.js";

export async function readRequiredTrimmedFile(
  filePath: string,
  label: string,
  readFileImpl: ReadFileText,
): Promise<string> {
  let raw: string;
  try {
    raw = await readFileImpl(filePath, "utf8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      throw createCliError(
        "CLI_CONNECTOR_MISSING_AGENT_MATERIAL",
        "Local agent credentials are missing for connector startup",
        { label },
      );
    }

    throw error;
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw createCliError(
      "CLI_CONNECTOR_MISSING_AGENT_MATERIAL",
      "Local agent credentials are missing for connector startup",
      { label },
    );
  }

  return trimmed;
}

export function parseRegistryAuth(
  rawRegistryAuth: string,
): Pick<
  ConnectorCredentials,
  | "accessToken"
  | "accessExpiresAt"
  | "refreshToken"
  | "refreshExpiresAt"
  | "tokenType"
> {
  const parsed = parseJsonRecord(
    rawRegistryAuth,
    "CLI_CONNECTOR_INVALID_REGISTRY_AUTH",
    "Agent registry auth is invalid for connector startup",
  );

  const refreshToken = parseNonEmptyString(parsed.refreshToken, "refreshToken");
  const accessToken =
    typeof parsed.accessToken === "string" &&
    parsed.accessToken.trim().length > 0
      ? parsed.accessToken.trim()
      : undefined;
  const accessExpiresAt =
    typeof parsed.accessExpiresAt === "string" &&
    parsed.accessExpiresAt.trim().length > 0
      ? parsed.accessExpiresAt.trim()
      : undefined;
  const refreshExpiresAt =
    typeof parsed.refreshExpiresAt === "string" &&
    parsed.refreshExpiresAt.trim().length > 0
      ? parsed.refreshExpiresAt.trim()
      : undefined;
  const tokenType = parsed.tokenType === "Bearer" ? "Bearer" : undefined;

  return {
    accessToken,
    accessExpiresAt,
    refreshToken,
    refreshExpiresAt,
    tokenType,
  };
}

export function parseAgentIdentity(rawIdentity: string): { did: string } {
  const parsed = parseJsonRecord(
    rawIdentity,
    "CLI_CONNECTOR_INVALID_AGENT_IDENTITY",
    "Agent identity is invalid for connector startup",
  );

  return {
    did: parseAgentDid(parsed.did),
  };
}
