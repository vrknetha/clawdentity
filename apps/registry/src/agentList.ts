import { parseUlid } from "@clawdentity/protocol";
import {
  AppError,
  type RegistryConfig,
  shouldExposeVerboseErrors,
} from "@clawdentity/sdk";

const DEFAULT_AGENT_LIST_LIMIT = 20;
const MAX_AGENT_LIST_LIMIT = 100;
const MAX_FRAMEWORK_LENGTH = 32;

type AgentStatus = "active" | "revoked";

export type AgentListQuery = {
  status?: AgentStatus;
  framework?: string;
  limit: number;
  cursor?: string;
};

export type AgentListRow = {
  id: string;
  did: string;
  name: string;
  status: AgentStatus;
  expires_at: string | null;
};

export type ListedAgent = {
  id: string;
  did: string;
  name: string;
  status: AgentStatus;
  expires: string | null;
};

type QueryRecord = Record<string, string | undefined>;

function invalidListQuery(options: {
  environment: RegistryConfig["ENVIRONMENT"];
  details?: {
    fieldErrors: Record<string, string[]>;
    formErrors: string[];
  };
}): AppError {
  const exposeDetails = shouldExposeVerboseErrors(options.environment);

  return new AppError({
    code: "AGENT_LIST_INVALID_QUERY",
    message: exposeDetails
      ? "Agent list query is invalid"
      : "Request could not be processed",
    status: 400,
    expose: exposeDetails,
    details: exposeDetails ? options.details : undefined,
  });
}

function addFieldError(
  fieldErrors: Record<string, string[]>,
  field: string,
  message: string,
): void {
  const errors = fieldErrors[field] ?? [];
  errors.push(message);
  fieldErrors[field] = errors;
}

function hasControlChars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) {
      return true;
    }
  }

  return false;
}

function parseStatus(
  input: string | undefined,
  fieldErrors: Record<string, string[]>,
): AgentStatus | undefined {
  if (input === undefined) {
    return undefined;
  }

  if (input === "active" || input === "revoked") {
    return input;
  }

  addFieldError(
    fieldErrors,
    "status",
    "status must be either 'active' or 'revoked'",
  );
  return undefined;
}

function parseFramework(
  input: string | undefined,
  fieldErrors: Record<string, string[]>,
): string | undefined {
  if (input === undefined) {
    return undefined;
  }

  const value = input.trim();
  if (value.length === 0) {
    addFieldError(fieldErrors, "framework", "framework is required");
    return undefined;
  }

  if (value.length > MAX_FRAMEWORK_LENGTH) {
    addFieldError(
      fieldErrors,
      "framework",
      `framework must be at most ${MAX_FRAMEWORK_LENGTH} characters`,
    );
  }

  if (hasControlChars(value)) {
    addFieldError(
      fieldErrors,
      "framework",
      "framework contains control characters",
    );
  }

  return value;
}

function parseLimit(
  input: string | undefined,
  fieldErrors: Record<string, string[]>,
): number {
  if (input === undefined) {
    return DEFAULT_AGENT_LIST_LIMIT;
  }

  const value = Number(input);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    addFieldError(fieldErrors, "limit", "limit must be an integer");
    return DEFAULT_AGENT_LIST_LIMIT;
  }

  if (value < 1 || value > MAX_AGENT_LIST_LIMIT) {
    addFieldError(
      fieldErrors,
      "limit",
      `limit must be between 1 and ${MAX_AGENT_LIST_LIMIT}`,
    );
    return DEFAULT_AGENT_LIST_LIMIT;
  }

  return value;
}

function parseCursor(
  input: string | undefined,
  fieldErrors: Record<string, string[]>,
): string | undefined {
  if (input === undefined) {
    return undefined;
  }

  const value = input.trim();
  if (value.length === 0) {
    addFieldError(fieldErrors, "cursor", "cursor is required");
    return undefined;
  }

  try {
    return parseUlid(value).value;
  } catch {
    addFieldError(fieldErrors, "cursor", "cursor must be a valid ULID");
    return undefined;
  }
}

export function parseAgentListQuery(input: {
  query: QueryRecord;
  environment: RegistryConfig["ENVIRONMENT"];
}): AgentListQuery {
  const fieldErrors: Record<string, string[]> = {};
  const status = parseStatus(input.query.status, fieldErrors);
  const framework = parseFramework(input.query.framework, fieldErrors);
  const limit = parseLimit(input.query.limit, fieldErrors);
  const cursor = parseCursor(input.query.cursor, fieldErrors);

  if (Object.keys(fieldErrors).length > 0) {
    throw invalidListQuery({
      environment: input.environment,
      details: {
        fieldErrors,
        formErrors: [],
      },
    });
  }

  return {
    status,
    framework,
    limit,
    cursor,
  };
}

export function mapAgentListRow(row: AgentListRow): ListedAgent {
  return {
    id: row.id,
    did: row.did,
    name: row.name,
    status: row.status,
    expires: row.expires_at,
  };
}

export { DEFAULT_AGENT_LIST_LIMIT, MAX_AGENT_LIST_LIMIT };
