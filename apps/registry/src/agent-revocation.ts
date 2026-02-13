import { parseUlid } from "@clawdentity/protocol";
import {
  AppError,
  type RegistryConfig,
  shouldExposeVerboseErrors,
} from "@clawdentity/sdk";

function invalidRevokePath(options: {
  environment: RegistryConfig["ENVIRONMENT"];
  details?: {
    fieldErrors: Record<string, string[]>;
    formErrors: string[];
  };
}): AppError {
  const exposeDetails = shouldExposeVerboseErrors(options.environment);
  return new AppError({
    code: "AGENT_REVOKE_INVALID_PATH",
    message: exposeDetails
      ? "Agent revoke path is invalid"
      : "Request could not be processed",
    status: 400,
    expose: exposeDetails,
    details: exposeDetails ? options.details : undefined,
  });
}

export function parseAgentRevokePath(input: {
  id: string;
  environment: RegistryConfig["ENVIRONMENT"];
}): string {
  const id = input.id.trim();
  if (id.length === 0) {
    throw invalidRevokePath({
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
    throw invalidRevokePath({
      environment: input.environment,
      details: {
        fieldErrors: { id: ["id must be a valid ULID"] },
        formErrors: [],
      },
    });
  }
}

export function agentNotFoundError(): AppError {
  return new AppError({
    code: "AGENT_NOT_FOUND",
    message: "Agent not found",
    status: 404,
    expose: true,
  });
}

export function invalidAgentRevokeStateError(options: {
  environment: RegistryConfig["ENVIRONMENT"];
  reason: string;
}): AppError {
  const exposeDetails = shouldExposeVerboseErrors(options.environment);
  return new AppError({
    code: "AGENT_REVOKE_INVALID_STATE",
    message: exposeDetails
      ? "Agent cannot be revoked"
      : "Request could not be processed",
    status: 409,
    expose: exposeDetails,
    details: exposeDetails
      ? {
          fieldErrors: { currentJti: [options.reason] },
          formErrors: [],
        }
      : undefined,
  });
}
