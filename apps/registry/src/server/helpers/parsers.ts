import {
  generateUlid,
  parseAgentDid as parseProtocolAgentDid,
  parseHumanDid as parseProtocolHumanDid,
  parseUlid,
} from "@clawdentity/protocol";
import {
  AppError,
  nowUtcMs,
  type RegistryConfig,
  shouldExposeVerboseErrors,
} from "@clawdentity/sdk";
import { parseAccessToken } from "../../auth/agent-auth-token.js";
import { constantTimeEqual } from "../../auth/api-key-token.js";
import { parseInternalServiceScopesPayload } from "../../auth/internal-service-scopes.js";
import {
  CRL_TTL_SECONDS,
  type CrlSnapshotRow,
  LANDING_URL_BY_ENVIRONMENT,
  PROXY_URL_BY_ENVIRONMENT,
} from "../constants.js";

function crlBuildError(options: {
  environment: RegistryConfig["ENVIRONMENT"];
  message: string;
  details?: {
    fieldErrors: Record<string, string[]>;
    formErrors: string[];
  };
}): AppError {
  const exposeDetails = shouldExposeVerboseErrors(options.environment);
  return new AppError({
    code: "CRL_BUILD_FAILED",
    message: exposeDetails
      ? options.message
      : "CRL snapshot could not be generated",
    status: 500,
    expose: exposeDetails,
    details: exposeDetails ? options.details : undefined,
  });
}

function parseRevokedAtSeconds(options: {
  environment: RegistryConfig["ENVIRONMENT"];
  revocationId: string;
  revokedAtIso: string;
}): number {
  const epochMillis = Date.parse(options.revokedAtIso);
  if (!Number.isFinite(epochMillis)) {
    throw crlBuildError({
      environment: options.environment,
      message: "CRL revocation timestamp is invalid",
      details: {
        fieldErrors: {
          revokedAt: [
            `revocation ${options.revocationId} has invalid revoked_at timestamp`,
          ],
        },
        formErrors: [],
      },
    });
  }

  return Math.floor(epochMillis / 1000);
}

export function buildCrlClaims(input: {
  rows: CrlSnapshotRow[];
  environment: RegistryConfig["ENVIRONMENT"];
  issuer: string;
  nowSeconds: number;
}) {
  return {
    iss: input.issuer,
    jti: generateUlid(nowUtcMs()),
    iat: input.nowSeconds,
    exp: input.nowSeconds + CRL_TTL_SECONDS,
    revocations: input.rows.map((row) => {
      const base = {
        jti: row.jti,
        agentDid: row.agent_did,
        revokedAt: parseRevokedAtSeconds({
          environment: input.environment,
          revocationId: row.id,
          revokedAtIso: row.revoked_at,
        }),
      };

      if (typeof row.reason === "string" && row.reason.length > 0) {
        return {
          ...base,
          reason: row.reason,
        };
      }

      return base;
    }),
  };
}

export function parseAgentAuthValidatePayload(payload: unknown): {
  agentDid: string;
  aitJti: string;
} {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new AppError({
      code: "AGENT_AUTH_VALIDATE_INVALID",
      message: "Validation payload is invalid",
      status: 400,
      expose: true,
    });
  }

  const value = payload as Record<string, unknown>;
  const agentDid =
    typeof value.agentDid === "string" ? value.agentDid.trim() : "";
  const aitJti = typeof value.aitJti === "string" ? value.aitJti.trim() : "";

  if (agentDid.length === 0 || aitJti.length === 0) {
    throw new AppError({
      code: "AGENT_AUTH_VALIDATE_INVALID",
      message: "Validation payload is invalid",
      status: 400,
      expose: true,
    });
  }

  return {
    agentDid,
    aitJti,
  };
}

export function parseAgentAccessHeaderToken(token: string | undefined): string {
  try {
    return parseAccessToken(token);
  } catch {
    throw new AppError({
      code: "AGENT_AUTH_VALIDATE_UNAUTHORIZED",
      message: "Agent access token is invalid",
      status: 401,
      expose: true,
    });
  }
}

function parseInternalServiceName(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^[a-z0-9][a-z0-9-_]{1,63}$/i.test(normalized)) {
    throw new AppError({
      code: "INTERNAL_SERVICE_INVALID",
      message: "Internal service payload is invalid",
      status: 400,
      expose: true,
    });
  }

  return normalized;
}

export function parseInternalServiceCreatePayload(payload: unknown): {
  name: string;
  scopes: string[];
} {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new AppError({
      code: "INTERNAL_SERVICE_INVALID",
      message: "Internal service payload is invalid",
      status: 400,
      expose: true,
    });
  }

  const value = payload as Record<string, unknown>;
  return {
    name: parseInternalServiceName(value.name),
    scopes: parseInternalServiceScopesPayload(value.scopes),
  };
}

export function parseInternalServicePathId(input: {
  id: string;
  environment: RegistryConfig["ENVIRONMENT"];
}): string {
  const candidate = input.id.trim();
  try {
    return parseUlid(candidate).value;
  } catch {
    throw new AppError({
      code: "INTERNAL_SERVICE_INVALID_PATH",
      message:
        input.environment === "production"
          ? "Request could not be processed"
          : "Internal service path is invalid",
      status: 400,
      expose: input.environment !== "production",
      details:
        input.environment === "production"
          ? undefined
          : {
              fieldErrors: { id: ["id must be a valid ULID"] },
              formErrors: [],
            },
    });
  }
}

export function parseInternalServiceRotatePayload(payload: unknown): {
  scopes?: string[];
} {
  if (payload === undefined || payload === null) {
    return {};
  }
  if (typeof payload !== "object" || Array.isArray(payload)) {
    throw new AppError({
      code: "INTERNAL_SERVICE_INVALID",
      message: "Internal service payload is invalid",
      status: 400,
      expose: true,
    });
  }

  const value = payload as Record<string, unknown>;
  if (value.scopes === undefined) {
    return {};
  }

  return {
    scopes: parseInternalServiceScopesPayload(value.scopes),
  };
}

function parseHumanDid(value: unknown): string {
  if (typeof value !== "string") {
    throw new AppError({
      code: "AGENT_OWNERSHIP_INVALID",
      message: "Ownership payload is invalid",
      status: 400,
      expose: true,
    });
  }

  const candidate = value.trim();
  try {
    parseProtocolHumanDid(candidate);
  } catch {
    throw new AppError({
      code: "AGENT_OWNERSHIP_INVALID",
      message: "Ownership payload is invalid",
      status: 400,
      expose: true,
    });
  }

  if (candidate.length === 0) {
    throw new AppError({
      code: "AGENT_OWNERSHIP_INVALID",
      message: "Ownership payload is invalid",
      status: 400,
      expose: true,
    });
  }

  return candidate;
}

function parseAgentDid(value: unknown): string {
  if (typeof value !== "string") {
    throw new AppError({
      code: "AGENT_OWNERSHIP_INVALID",
      message: "Ownership payload is invalid",
      status: 400,
      expose: true,
    });
  }

  const candidate = value.trim();
  try {
    parseProtocolAgentDid(candidate);
  } catch {
    throw new AppError({
      code: "AGENT_OWNERSHIP_INVALID",
      message: "Ownership payload is invalid",
      status: 400,
      expose: true,
    });
  }

  if (candidate.length === 0) {
    throw new AppError({
      code: "AGENT_OWNERSHIP_INVALID",
      message: "Ownership payload is invalid",
      status: 400,
      expose: true,
    });
  }

  return candidate;
}

export function parseInternalOwnershipCheckPayload(payload: unknown): {
  ownerDid: string;
  agentDid: string;
} {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new AppError({
      code: "AGENT_OWNERSHIP_INVALID",
      message: "Ownership payload is invalid",
      status: 400,
      expose: true,
    });
  }

  const value = payload as Record<string, unknown>;
  let ownerDid: string;
  try {
    ownerDid = parseHumanDid(value.ownerDid);
  } catch {
    throw new AppError({
      code: "AGENT_OWNERSHIP_INVALID",
      message: "Ownership payload is invalid",
      status: 400,
      expose: true,
    });
  }

  return {
    ownerDid,
    agentDid: parseAgentDid(value.agentDid),
  };
}

export function requireCurrentJti(input: {
  currentJti: string | null;
  onInvalid: (reason: string) => AppError;
}): string {
  if (typeof input.currentJti !== "string" || input.currentJti.length === 0) {
    throw input.onInvalid("agent.current_jti is required");
  }

  return input.currentJti;
}

export function requireBootstrapSecret(
  bootstrapSecret: string | undefined,
): string {
  if (typeof bootstrapSecret === "string" && bootstrapSecret.length > 0) {
    return bootstrapSecret;
  }

  throw new AppError({
    code: "ADMIN_BOOTSTRAP_DISABLED",
    message: "Admin bootstrap is disabled",
    status: 503,
    expose: true,
  });
}

export function parseBootstrapSecretHeader(
  headerValue: string | undefined,
): string {
  if (typeof headerValue !== "string" || headerValue.trim().length === 0) {
    throw new AppError({
      code: "ADMIN_BOOTSTRAP_UNAUTHORIZED",
      message: "Bootstrap secret is required",
      status: 401,
      expose: true,
    });
  }

  return headerValue.trim();
}

export function assertBootstrapSecretAuthorized(input: {
  provided: string;
  expected: string;
}): void {
  if (!constantTimeEqual(input.provided, input.expected)) {
    throw new AppError({
      code: "ADMIN_BOOTSTRAP_UNAUTHORIZED",
      message: "Bootstrap secret is invalid",
      status: 401,
      expose: true,
    });
  }
}

export function adminBootstrapAlreadyCompletedError(): AppError {
  return new AppError({
    code: "ADMIN_BOOTSTRAP_ALREADY_COMPLETED",
    message: "Admin bootstrap has already completed",
    status: 409,
    expose: true,
  });
}

export function resolveProxyUrl(config: RegistryConfig): string {
  return config.PROXY_URL ?? PROXY_URL_BY_ENVIRONMENT[config.ENVIRONMENT];
}

export function resolveLandingUrl(config: RegistryConfig): string {
  return config.LANDING_URL ?? LANDING_URL_BY_ENVIRONMENT[config.ENVIRONMENT];
}

export function isIsoExpired(expiresAtIso: string, nowMillis: number): boolean {
  const parsed = Date.parse(expiresAtIso);
  if (!Number.isFinite(parsed)) {
    return true;
  }

  return parsed <= nowMillis;
}
