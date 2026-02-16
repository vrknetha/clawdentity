import { parseUlid } from "@clawdentity/protocol";
import {
  AppError,
  type RegistryConfig,
  shouldExposeVerboseErrors,
} from "@clawdentity/sdk";

const DEFAULT_API_KEY_NAME = "api-key";
const MAX_API_KEY_NAME_LENGTH = 64;

type ApiKeyMetadataRow = {
  id: string;
  name: string;
  status: "active" | "revoked";
  created_at: string;
  last_used_at: string | null;
};

type ApiKeyCreatePayload = {
  name: string;
};

function hasControlChars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) {
      return true;
    }
  }

  return false;
}

function apiKeyCreateInvalidError(options: {
  environment: RegistryConfig["ENVIRONMENT"];
  details?: {
    fieldErrors: Record<string, string[]>;
    formErrors: string[];
  };
}): AppError {
  const exposeDetails = shouldExposeVerboseErrors(options.environment);
  return new AppError({
    code: "API_KEY_CREATE_INVALID",
    message: exposeDetails
      ? "API key create payload is invalid"
      : "Request could not be processed",
    status: 400,
    expose: exposeDetails,
    details: exposeDetails ? options.details : undefined,
  });
}

function apiKeyRevokeInvalidPathError(options: {
  environment: RegistryConfig["ENVIRONMENT"];
  details?: {
    fieldErrors: Record<string, string[]>;
    formErrors: string[];
  };
}): AppError {
  const exposeDetails = shouldExposeVerboseErrors(options.environment);
  return new AppError({
    code: "API_KEY_REVOKE_INVALID_PATH",
    message: exposeDetails
      ? "API key revoke path is invalid"
      : "Request could not be processed",
    status: 400,
    expose: exposeDetails,
    details: exposeDetails ? options.details : undefined,
  });
}

function parseOptionalTrimmedString(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parseApiKeyCreatePayload(input: {
  payload: unknown;
  environment: RegistryConfig["ENVIRONMENT"];
}): ApiKeyCreatePayload {
  const exposeDetails = shouldExposeVerboseErrors(input.environment);
  if (
    typeof input.payload !== "object" ||
    input.payload === null ||
    Array.isArray(input.payload)
  ) {
    throw new AppError({
      code: "API_KEY_CREATE_INVALID",
      message: exposeDetails
        ? "API key create payload is invalid"
        : "Request could not be processed",
      status: 400,
      expose: exposeDetails,
      details: exposeDetails
        ? {
            fieldErrors: { body: ["body must be a JSON object"] },
            formErrors: [],
          }
        : undefined,
    });
  }

  const payload = input.payload as Record<string, unknown>;
  const fieldErrors: Record<string, string[]> = {};

  if (payload.name !== undefined && typeof payload.name !== "string") {
    fieldErrors.name = ["name must be a string"];
  }

  const nameInput = parseOptionalTrimmedString(payload.name);
  if (
    payload.name !== undefined &&
    nameInput === undefined &&
    !fieldErrors.name
  ) {
    fieldErrors.name = ["name must not be empty"];
  }

  const name = nameInput ?? DEFAULT_API_KEY_NAME;
  if (name.length > MAX_API_KEY_NAME_LENGTH) {
    fieldErrors.name = [
      `name must be at most ${MAX_API_KEY_NAME_LENGTH} characters`,
    ];
  } else if (hasControlChars(name)) {
    fieldErrors.name = ["name contains control characters"];
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw apiKeyCreateInvalidError({
      environment: input.environment,
      details: { fieldErrors, formErrors: [] },
    });
  }

  return { name };
}

export function parseApiKeyRevokePath(input: {
  id: string;
  environment: RegistryConfig["ENVIRONMENT"];
}): string {
  const id = input.id.trim();
  if (id.length === 0) {
    throw apiKeyRevokeInvalidPathError({
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
    throw apiKeyRevokeInvalidPathError({
      environment: input.environment,
      details: {
        fieldErrors: { id: ["id must be a valid ULID"] },
        formErrors: [],
      },
    });
  }
}

export function apiKeyNotFoundError(): AppError {
  return new AppError({
    code: "API_KEY_NOT_FOUND",
    message: "API key not found",
    status: 404,
    expose: true,
  });
}

export function mapApiKeyMetadataRow(row: ApiKeyMetadataRow) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}
