import { generateUlid } from "@clawdentity/protocol";
import {
  AppError,
  addSeconds,
  nowIso,
  nowUtcMs,
  type RegistryConfig,
  shouldExposeVerboseErrors,
} from "@clawdentity/sdk";
import {
  deriveAccessTokenLookupPrefix,
  deriveRefreshTokenLookupPrefix,
  generateAccessToken,
  generateRefreshToken,
  hashAgentToken,
  parseRefreshToken,
} from "./auth/agent-auth-token.js";

export const DEFAULT_AGENT_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const DEFAULT_AGENT_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export type AgentAuthIssue = {
  sessionId: string;
  accessToken: string;
  accessTokenHash: string;
  accessTokenPrefix: string;
  refreshToken: string;
  refreshTokenHash: string;
  refreshTokenPrefix: string;
  accessIssuedAt: string;
  accessExpiresAt: string;
  refreshIssuedAt: string;
  refreshExpiresAt: string;
  createdAt: string;
  updatedAt: string;
};

export type AgentAuthResponse = {
  tokenType: "Bearer";
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
};

function invalidRefreshPayloadError(options: {
  environment: RegistryConfig["ENVIRONMENT"];
  details?: {
    fieldErrors: Record<string, string[]>;
    formErrors: string[];
  };
}): AppError {
  const exposeDetails = shouldExposeVerboseErrors(options.environment);
  return new AppError({
    code: "AGENT_AUTH_REFRESH_INVALID",
    message: exposeDetails
      ? "Refresh payload is invalid"
      : "Request could not be processed",
    status: 400,
    expose: true,
    details: exposeDetails ? options.details : undefined,
  });
}

export function parseAgentAuthRefreshPayload(input: {
  payload: unknown;
  environment: RegistryConfig["ENVIRONMENT"];
}): { refreshToken: string } {
  if (
    typeof input.payload !== "object" ||
    input.payload === null ||
    Array.isArray(input.payload)
  ) {
    throw invalidRefreshPayloadError({
      environment: input.environment,
      details: {
        fieldErrors: {
          body: ["body must be a JSON object"],
        },
        formErrors: [],
      },
    });
  }

  const payload = input.payload as Record<string, unknown>;
  if (typeof payload.refreshToken !== "string") {
    throw invalidRefreshPayloadError({
      environment: input.environment,
      details: {
        fieldErrors: {
          refreshToken: ["refreshToken is required"],
        },
        formErrors: [],
      },
    });
  }

  let refreshToken: string;
  try {
    refreshToken = parseRefreshToken(payload.refreshToken);
  } catch {
    throw invalidRefreshPayloadError({
      environment: input.environment,
      details: {
        fieldErrors: {
          refreshToken: ["refreshToken format is invalid"],
        },
        formErrors: [],
      },
    });
  }

  return {
    refreshToken,
  };
}

export async function issueAgentAuth(options?: {
  nowMs?: number;
  accessTtlSeconds?: number;
  refreshTtlSeconds?: number;
}): Promise<AgentAuthIssue> {
  const nowMs = options?.nowMs ?? nowUtcMs();
  const accessTtlSeconds =
    options?.accessTtlSeconds ?? DEFAULT_AGENT_ACCESS_TOKEN_TTL_SECONDS;
  const refreshTtlSeconds =
    options?.refreshTtlSeconds ?? DEFAULT_AGENT_REFRESH_TOKEN_TTL_SECONDS;
  const accessToken = generateAccessToken();
  const refreshToken = generateRefreshToken();

  const [accessTokenHash, refreshTokenHash] = await Promise.all([
    hashAgentToken(accessToken),
    hashAgentToken(refreshToken),
  ]);

  const accessIssuedAt = nowIso();
  const refreshIssuedAt = accessIssuedAt;
  const accessExpiresAt = addSeconds(nowMs, accessTtlSeconds);
  const refreshExpiresAt = addSeconds(nowMs, refreshTtlSeconds);
  const createdAt = accessIssuedAt;
  const updatedAt = accessIssuedAt;

  return {
    sessionId: generateUlid(nowMs),
    accessToken,
    accessTokenHash,
    accessTokenPrefix: deriveAccessTokenLookupPrefix(accessToken),
    refreshToken,
    refreshTokenHash,
    refreshTokenPrefix: deriveRefreshTokenLookupPrefix(refreshToken),
    accessIssuedAt,
    accessExpiresAt,
    refreshIssuedAt,
    refreshExpiresAt,
    createdAt,
    updatedAt,
  };
}

export function toAgentAuthResponse(input: {
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
}): AgentAuthResponse {
  return {
    tokenType: "Bearer",
    accessToken: input.accessToken,
    accessExpiresAt: input.accessExpiresAt,
    refreshToken: input.refreshToken,
    refreshExpiresAt: input.refreshExpiresAt,
  };
}

export function agentAuthRefreshUnauthorizedError(): AppError {
  return new AppError({
    code: "AGENT_AUTH_REFRESH_UNAUTHORIZED",
    message: "Agent auth refresh is unauthorized",
    status: 401,
    expose: true,
  });
}

export function agentAuthRefreshRejectedError(options: {
  code:
    | "AGENT_AUTH_REFRESH_REVOKED"
    | "AGENT_AUTH_REFRESH_EXPIRED"
    | "AGENT_AUTH_REFRESH_INVALID";
  message: string;
}): AppError {
  return new AppError({
    code: options.code,
    message: options.message,
    status: 401,
    expose: true,
  });
}

export function agentAuthRefreshConflictError(): AppError {
  return new AppError({
    code: "AGENT_AUTH_REFRESH_CONFLICT",
    message: "Agent auth refresh state changed; retry request",
    status: 409,
    expose: true,
  });
}
