import { parseUlid } from "@clawdentity/protocol";
import {
  AppError,
  type RegistryConfig,
  shouldExposeVerboseErrors,
} from "@clawdentity/sdk";

function invalidOwnershipPath(options: {
  environment: RegistryConfig["ENVIRONMENT"];
  details?: {
    fieldErrors: Record<string, string[]>;
    formErrors: string[];
  };
}): AppError {
  const exposeDetails = shouldExposeVerboseErrors(options.environment);
  return new AppError({
    code: "AGENT_OWNERSHIP_INVALID_PATH",
    message: exposeDetails
      ? "Agent ownership path is invalid"
      : "Request could not be processed",
    status: 400,
    expose: exposeDetails,
    details: exposeDetails ? options.details : undefined,
  });
}

export function parseAgentOwnershipPath(input: {
  id: string;
  environment: RegistryConfig["ENVIRONMENT"];
}): string {
  const id = input.id.trim();
  if (id.length === 0) {
    throw invalidOwnershipPath({
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
    throw invalidOwnershipPath({
      environment: input.environment,
      details: {
        fieldErrors: { id: ["id must be a valid ULID"] },
        formErrors: [],
      },
    });
  }
}
