import { parseJsonResponseSafe as parseJsonResponse } from "@clawdentity/common";
import {
  INTERNAL_IDENTITY_AGENT_OWNERSHIP_PATH,
  parseAgentDid,
  parseHumanDid,
} from "@clawdentity/protocol";
import { AppError } from "./exceptions.js";

export const INTERNAL_SERVICE_ID_HEADER = "x-claw-service-id";
export const INTERNAL_SERVICE_SECRET_HEADER = "x-claw-service-secret";

export type AgentOwnershipStatus = "active" | "revoked" | null;

export type AgentOwnershipResult = {
  ownsAgent: boolean;
  agentStatus: AgentOwnershipStatus;
};

type RegistryErrorEnvelope = {
  error?: {
    code?: string;
    message?: string;
  };
};

type RegistryIdentityClientInput = {
  fetchImpl?: typeof fetch;
  registryUrl: string;
  serviceId: string;
  serviceSecret: string;
};

function normalizeRegistryUrl(registryUrl: string): string {
  const normalized = registryUrl.endsWith("/")
    ? registryUrl
    : `${registryUrl}/`;
  return new URL(normalized).toString();
}

function toIdentityPathWithQuery(urlString: string): string {
  const parsed = new URL(urlString);
  return `${parsed.pathname}${parsed.search}`;
}

function parseRegistryErrorEnvelope(payload: unknown): RegistryErrorEnvelope {
  if (typeof payload !== "object" || payload === null) {
    return {};
  }

  const error = (payload as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) {
    return {};
  }

  return {
    error: {
      code:
        typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : undefined,
      message:
        typeof (error as { message?: unknown }).message === "string"
          ? (error as { message: string }).message
          : undefined,
    },
  };
}

function parseOwnershipResponse(payload: unknown): AgentOwnershipResult {
  if (typeof payload !== "object" || payload === null) {
    throw new AppError({
      code: "IDENTITY_SERVICE_INVALID_RESPONSE",
      message: "Registry identity response is invalid",
      status: 503,
      expose: true,
    });
  }

  const ownsAgent = (payload as { ownsAgent?: unknown }).ownsAgent;
  const agentStatus = (payload as { agentStatus?: unknown }).agentStatus;

  if (
    typeof ownsAgent !== "boolean" ||
    !(
      agentStatus === "active" ||
      agentStatus === "revoked" ||
      agentStatus === null
    )
  ) {
    throw new AppError({
      code: "IDENTITY_SERVICE_INVALID_RESPONSE",
      message: "Registry identity response is invalid",
      status: 503,
      expose: true,
    });
  }

  return {
    ownsAgent,
    agentStatus,
  };
}

function validateServiceIdentity(input: RegistryIdentityClientInput): void {
  const serviceId = input.serviceId.trim();
  const serviceSecret = input.serviceSecret.trim();

  if (serviceId.length === 0 || serviceSecret.length === 0) {
    throw new AppError({
      code: "IDENTITY_SERVICE_CONFIG_INVALID",
      message: "Registry internal service credentials are not configured",
      status: 500,
      expose: true,
    });
  }
}

function validateOwnershipInput(input: {
  ownerDid: string;
  agentDid: string;
}): void {
  try {
    parseHumanDid(input.ownerDid);
    parseAgentDid(input.agentDid);
  } catch {
    throw new AppError({
      code: "IDENTITY_SERVICE_INVALID_INPUT",
      message: "Ownership input is invalid",
      status: 400,
      expose: true,
    });
  }
}

export function createRegistryIdentityClient(
  input: RegistryIdentityClientInput,
) {
  const fetchImpl = input.fetchImpl ?? fetch;
  if (typeof fetchImpl !== "function") {
    throw new AppError({
      code: "IDENTITY_SERVICE_CONFIG_INVALID",
      message: "fetch implementation is required",
      status: 500,
      expose: true,
    });
  }

  const registryUrl = normalizeRegistryUrl(input.registryUrl);
  validateServiceIdentity(input);

  return {
    async checkAgentOwnership(payload: {
      ownerDid: string;
      agentDid: string;
    }): Promise<AgentOwnershipResult> {
      validateOwnershipInput(payload);

      const requestUrl = new URL(
        INTERNAL_IDENTITY_AGENT_OWNERSHIP_PATH.slice(1),
        registryUrl,
      ).toString();
      const requestBody = JSON.stringify({
        ownerDid: payload.ownerDid,
        agentDid: payload.agentDid,
      });

      let response: Response;
      try {
        response = await fetchImpl(requestUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [INTERNAL_SERVICE_ID_HEADER]: input.serviceId.trim(),
            [INTERNAL_SERVICE_SECRET_HEADER]: input.serviceSecret.trim(),
          },
          body: requestBody,
        });
      } catch {
        throw new AppError({
          code: "IDENTITY_SERVICE_UNAVAILABLE",
          message: "Registry identity service is unavailable",
          status: 503,
          expose: true,
        });
      }

      const responseBody = await parseJsonResponse(response);
      if (response.status === 401 || response.status === 403) {
        const parsedError = parseRegistryErrorEnvelope(responseBody);
        throw new AppError({
          code: "IDENTITY_SERVICE_UNAUTHORIZED",
          message:
            parsedError.error?.message ??
            "Registry internal service authorization failed",
          status: 503,
          expose: true,
          details: {
            registryCode: parsedError.error?.code,
          },
        });
      }

      if (!response.ok) {
        const parsedError = parseRegistryErrorEnvelope(responseBody);
        throw new AppError({
          code: "IDENTITY_SERVICE_UNAVAILABLE",
          message:
            parsedError.error?.message ??
            "Registry identity service is unavailable",
          status: 503,
          expose: true,
          details: {
            status: response.status,
            registryCode: parsedError.error?.code,
            pathWithQuery: toIdentityPathWithQuery(requestUrl),
          },
        });
      }

      return parseOwnershipResponse(responseBody);
    },
  };
}
