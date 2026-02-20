import { parseDid } from "@clawdentity/protocol";
import { toIso } from "@clawdentity/sdk";
import { IDENTITY_FILE_NAME } from "./paths.js";
import type {
  AgentAuthBundle,
  AgentRegistrationChallengeResponse,
  AgentRegistrationResponse,
  RegistryErrorEnvelope,
} from "./types.js";

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

export const parseNonEmptyString = (value: unknown): string => {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
};

export const parseAgentIdFromDid = (agentName: string, did: string): string => {
  try {
    const parsedDid = parseDid(did);
    if (parsedDid.kind !== "agent") {
      throw new Error("DID is not an agent DID");
    }

    return parsedDid.ulid;
  } catch {
    throw new Error(
      `Agent "${agentName}" has invalid did in ${IDENTITY_FILE_NAME}: ${did}`,
    );
  }
};

export const formatExpiresAt = (expires: number): string => {
  return toIso(expires * 1000);
};

export const resolveFramework = (
  framework: string | undefined,
): string | undefined => {
  if (framework === undefined) {
    return undefined;
  }

  const normalizedFramework = framework.trim();
  if (normalizedFramework.length === 0) {
    throw new Error("--framework must not be empty when provided");
  }

  return normalizedFramework;
};

export const resolveTtlDays = (
  ttlDays: string | undefined,
): number | undefined => {
  if (ttlDays === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(ttlDays, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("--ttl-days must be a positive integer");
  }

  return parsed;
};

export const extractRegistryErrorMessage = (
  payload: unknown,
): string | undefined => {
  if (!isRecord(payload)) {
    return undefined;
  }

  const envelope = payload as RegistryErrorEnvelope;
  if (!envelope.error || typeof envelope.error.message !== "string") {
    return undefined;
  }

  const trimmed = envelope.error.message.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const parseJsonResponse = async (
  response: Response,
): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
};

const parseAgentAuthBundle = (value: unknown): AgentAuthBundle => {
  if (!isRecord(value)) {
    throw new Error("Registry returned an invalid response payload");
  }

  const tokenType = value.tokenType;
  const accessToken = value.accessToken;
  const accessExpiresAt = value.accessExpiresAt;
  const refreshToken = value.refreshToken;
  const refreshExpiresAt = value.refreshExpiresAt;

  if (
    tokenType !== "Bearer" ||
    typeof accessToken !== "string" ||
    typeof accessExpiresAt !== "string" ||
    typeof refreshToken !== "string" ||
    typeof refreshExpiresAt !== "string"
  ) {
    throw new Error("Registry returned an invalid response payload");
  }

  return {
    tokenType,
    accessToken,
    accessExpiresAt,
    refreshToken,
    refreshExpiresAt,
  };
};

export const parseAgentRegistrationResponse = (
  payload: unknown,
): AgentRegistrationResponse => {
  if (!isRecord(payload)) {
    throw new Error("Registry returned an invalid response payload");
  }

  const agentValue = payload.agent;
  const aitValue = payload.ait;
  const agentAuthValue = payload.agentAuth;

  if (
    !isRecord(agentValue) ||
    typeof aitValue !== "string" ||
    !isRecord(agentAuthValue)
  ) {
    throw new Error("Registry returned an invalid response payload");
  }

  const did = agentValue.did;
  const name = agentValue.name;
  const framework = agentValue.framework;
  const expiresAt = agentValue.expiresAt;

  if (
    typeof did !== "string" ||
    typeof name !== "string" ||
    typeof framework !== "string" ||
    typeof expiresAt !== "string"
  ) {
    throw new Error("Registry returned an invalid response payload");
  }

  return {
    agent: {
      did,
      name,
      framework,
      expiresAt,
    },
    ait: aitValue,
    agentAuth: parseAgentAuthBundle(agentAuthValue),
  };
};

export const parseAgentRegistrationChallengeResponse = (
  payload: unknown,
): AgentRegistrationChallengeResponse => {
  if (!isRecord(payload)) {
    throw new Error("Registry returned an invalid response payload");
  }

  const challengeId = payload.challengeId;
  const nonce = payload.nonce;
  const ownerDid = payload.ownerDid;
  const expiresAt = payload.expiresAt;

  if (
    typeof challengeId !== "string" ||
    typeof nonce !== "string" ||
    typeof ownerDid !== "string" ||
    typeof expiresAt !== "string"
  ) {
    throw new Error("Registry returned an invalid response payload");
  }

  return {
    challengeId,
    nonce,
    ownerDid,
    expiresAt,
  };
};
