import {
  AppError,
  type RegistryConfig,
  shouldExposeVerboseErrors,
} from "@clawdentity/sdk";

const DEFAULT_ADMIN_DISPLAY_NAME = "Admin";
const DEFAULT_API_KEY_NAME = "bootstrap-admin";
const MAX_DISPLAY_NAME_LENGTH = 64;
const MAX_API_KEY_NAME_LENGTH = 64;

function hasControlChars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) {
      return true;
    }
  }

  return false;
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

type BootstrapPayload = {
  displayName: string;
  apiKeyName: string;
};

export function parseAdminBootstrapPayload(input: {
  payload: unknown;
  environment: RegistryConfig["ENVIRONMENT"];
}): BootstrapPayload {
  const exposeDetails = shouldExposeVerboseErrors(input.environment);
  if (
    typeof input.payload !== "object" ||
    input.payload === null ||
    Array.isArray(input.payload)
  ) {
    throw new AppError({
      code: "ADMIN_BOOTSTRAP_INVALID",
      message: exposeDetails
        ? "Bootstrap payload is invalid"
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

  if (
    payload.displayName !== undefined &&
    typeof payload.displayName !== "string"
  ) {
    fieldErrors.displayName = ["displayName must be a string"];
  }
  if (
    payload.apiKeyName !== undefined &&
    typeof payload.apiKeyName !== "string"
  ) {
    fieldErrors.apiKeyName = ["apiKeyName must be a string"];
  }

  const displayNameInput = parseOptionalTrimmedString(payload.displayName);
  const apiKeyNameInput = parseOptionalTrimmedString(payload.apiKeyName);
  if (
    payload.displayName !== undefined &&
    displayNameInput === undefined &&
    !fieldErrors.displayName
  ) {
    fieldErrors.displayName = ["displayName must not be empty"];
  }
  if (
    payload.apiKeyName !== undefined &&
    apiKeyNameInput === undefined &&
    !fieldErrors.apiKeyName
  ) {
    fieldErrors.apiKeyName = ["apiKeyName must not be empty"];
  }

  const displayName = displayNameInput ?? DEFAULT_ADMIN_DISPLAY_NAME;
  const apiKeyName = apiKeyNameInput ?? DEFAULT_API_KEY_NAME;
  if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    fieldErrors.displayName = ["displayName must be at most 64 characters"];
  } else if (hasControlChars(displayName)) {
    fieldErrors.displayName = ["displayName contains control characters"];
  }

  if (apiKeyName.length > MAX_API_KEY_NAME_LENGTH) {
    fieldErrors.apiKeyName = ["apiKeyName must be at most 64 characters"];
  } else if (hasControlChars(apiKeyName)) {
    fieldErrors.apiKeyName = ["apiKeyName contains control characters"];
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw new AppError({
      code: "ADMIN_BOOTSTRAP_INVALID",
      message: exposeDetails
        ? "Bootstrap payload is invalid"
        : "Request could not be processed",
      status: 400,
      expose: exposeDetails,
      details: exposeDetails ? { fieldErrors, formErrors: [] } : undefined,
    });
  }

  return {
    displayName,
    apiKeyName,
  };
}
