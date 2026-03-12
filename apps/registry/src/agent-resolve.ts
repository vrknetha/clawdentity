import { parseUlid } from "@clawdentity/protocol";
import {
  AppError,
  type RegistryConfig,
  shouldExposeVerboseErrors,
} from "@clawdentity/sdk";

const DEFAULT_RESOLVED_FRAMEWORK = "openclaw";

type AgentStatus = "active" | "revoked";

type ResolvePathErrorDetails = {
  fieldErrors: Record<string, string[]>;
  formErrors: string[];
};

export type ResolvedAgentRow = {
  did: string;
  name: string;
  framework: string | null;
  status: AgentStatus;
  owner_did: string;
};

export type ResolvedAgent = {
  did: string;
  name: string;
  framework: string;
  status: AgentStatus;
  ownerDid: string;
};

function invalidResolvePathError(options: {
  environment: RegistryConfig["ENVIRONMENT"];
  details?: ResolvePathErrorDetails;
}): AppError {
  const exposeDetails = shouldExposeVerboseErrors(options.environment);
  return new AppError({
    code: "AGENT_RESOLVE_INVALID_PATH",
    message: exposeDetails
      ? "Agent resolve path is invalid"
      : "Request could not be processed",
    status: 400,
    expose: exposeDetails,
    details: exposeDetails ? options.details : undefined,
  });
}

export function parseAgentResolvePath(input: {
  id: string;
  environment: RegistryConfig["ENVIRONMENT"];
}): string {
  const id = input.id.trim();
  if (id.length === 0) {
    throw invalidResolvePathError({
      environment: input.environment,
      details: {
        fieldErrors: { id: ["id is required"] },
        formErrors: [],
      },
    });
  }

  try {
    return parseUlid(id).value;
  } catch {
    throw invalidResolvePathError({
      environment: input.environment,
      details: {
        fieldErrors: { id: ["id must be a valid ULID"] },
        formErrors: [],
      },
    });
  }
}

export function agentResolveNotFoundError(): AppError {
  return new AppError({
    code: "AGENT_NOT_FOUND",
    message: "Agent not found",
    status: 404,
    expose: true,
  });
}

export function mapResolvedAgentRow(row: ResolvedAgentRow): ResolvedAgent {
  const framework =
    typeof row.framework === "string" && row.framework.length > 0
      ? row.framework
      : DEFAULT_RESOLVED_FRAMEWORK;

  return {
    did: row.did,
    name: row.name,
    framework,
    status: row.status,
    ownerDid: row.owner_did,
  };
}
