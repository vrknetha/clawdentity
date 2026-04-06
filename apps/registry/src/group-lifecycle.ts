import { encodeBase64url, parseGroupId } from "@clawdentity/protocol";
import {
  AppError,
  type RegistryConfig,
  shouldExposeVerboseErrors,
} from "@clawdentity/sdk";

const MAX_GROUP_NAME_LENGTH = 80;
const GROUP_JOIN_TOKEN_MARKER = "clw_gjt_";
const GROUP_JOIN_TOKEN_LOOKUP_ENTROPY_LENGTH = 8;
const GROUP_JOIN_TOKEN_RANDOM_BYTES_LENGTH = 32;

export const MAX_GROUP_MEMBERS = 25;

export type GroupCreatePayload = {
  name: string;
};

export type GroupJoinTokenIssuePayload = Record<never, never>;

export type GroupJoinPayload = {
  groupJoinToken: string;
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

function parseOptionalTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function groupCreateInvalidError(options: {
  environment: RegistryConfig["ENVIRONMENT"];
  details?: {
    fieldErrors: Record<string, string[]>;
    formErrors: string[];
  };
}): AppError {
  const exposeDetails = shouldExposeVerboseErrors(options.environment);
  return new AppError({
    code: "GROUP_CREATE_INVALID",
    message: exposeDetails
      ? "Group create payload is invalid"
      : "Request could not be processed",
    status: 400,
    expose: exposeDetails,
    details: exposeDetails ? options.details : undefined,
  });
}

function groupJoinTokenIssueInvalidError(options: {
  environment: RegistryConfig["ENVIRONMENT"];
  details?: {
    fieldErrors: Record<string, string[]>;
    formErrors: string[];
  };
}): AppError {
  const exposeDetails = shouldExposeVerboseErrors(options.environment);
  return new AppError({
    code: "GROUP_JOIN_TOKEN_ISSUE_INVALID",
    message: exposeDetails
      ? "Group join token payload is invalid"
      : "Request could not be processed",
    status: 400,
    expose: exposeDetails,
    details: exposeDetails ? options.details : undefined,
  });
}

function groupJoinInvalidError(options: {
  environment: RegistryConfig["ENVIRONMENT"];
  details?: {
    fieldErrors: Record<string, string[]>;
    formErrors: string[];
  };
}): AppError {
  const exposeDetails = shouldExposeVerboseErrors(options.environment);
  return new AppError({
    code: "GROUP_JOIN_INVALID",
    message: exposeDetails
      ? "Group join payload is invalid"
      : "Request could not be processed",
    status: 400,
    expose: exposeDetails,
    details: exposeDetails ? options.details : undefined,
  });
}

export function parseGroupCreatePayload(input: {
  payload: unknown;
  environment: RegistryConfig["ENVIRONMENT"];
}): GroupCreatePayload {
  if (
    typeof input.payload !== "object" ||
    input.payload === null ||
    Array.isArray(input.payload)
  ) {
    throw groupCreateInvalidError({
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
  const fieldErrors: Record<string, string[]> = {};

  if (typeof payload.name !== "string") {
    fieldErrors.name = ["name is required"];
  }

  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  if (name.length === 0 && !fieldErrors.name) {
    fieldErrors.name = ["name is required"];
  } else if (name.length > MAX_GROUP_NAME_LENGTH) {
    fieldErrors.name = [
      `name must be at most ${MAX_GROUP_NAME_LENGTH} characters`,
    ];
  } else if (hasControlChars(name)) {
    fieldErrors.name = ["name contains control characters"];
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw groupCreateInvalidError({
      environment: input.environment,
      details: { fieldErrors, formErrors: [] },
    });
  }

  return { name };
}

export function parseGroupJoinTokenIssuePayload(input: {
  payload: unknown;
  environment: RegistryConfig["ENVIRONMENT"];
}): GroupJoinTokenIssuePayload {
  if (
    typeof input.payload !== "object" ||
    input.payload === null ||
    Array.isArray(input.payload)
  ) {
    throw groupJoinTokenIssueInvalidError({
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
  const fieldErrors: Record<string, string[]> = {};

  if (payload.expiresInSeconds !== undefined) {
    fieldErrors.expiresInSeconds = [
      "expiresInSeconds is not supported; active group join tokens do not expire",
    ];
  }

  if (payload.maxUses !== undefined) {
    fieldErrors.maxUses = [
      "maxUses is not supported; active group join tokens are reusable",
    ];
  }

  if (payload.role !== undefined) {
    fieldErrors.role = ["role is not supported"];
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw groupJoinTokenIssueInvalidError({
      environment: input.environment,
      details: { fieldErrors, formErrors: [] },
    });
  }

  return {};
}

export function parseGroupJoinPayload(input: {
  payload: unknown;
  environment: RegistryConfig["ENVIRONMENT"];
}): GroupJoinPayload {
  if (
    typeof input.payload !== "object" ||
    input.payload === null ||
    Array.isArray(input.payload)
  ) {
    throw groupJoinInvalidError({
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
  const token = parseOptionalTrimmedString(payload.groupJoinToken);
  if (!token || !token.startsWith(GROUP_JOIN_TOKEN_MARKER)) {
    throw groupJoinInvalidError({
      environment: input.environment,
      details: {
        fieldErrors: {
          groupJoinToken: ["groupJoinToken is invalid"],
        },
        formErrors: [],
      },
    });
  }

  return {
    groupJoinToken: token,
  };
}

export function parseGroupIdPath(input: {
  id: string;
  environment: RegistryConfig["ENVIRONMENT"];
}): string {
  try {
    return parseGroupId(input.id.trim());
  } catch {
    throw new AppError({
      code: "GROUP_INVALID_PATH",
      message:
        input.environment === "production"
          ? "Request could not be processed"
          : "Group path is invalid",
      status: 400,
      expose: input.environment !== "production",
    });
  }
}

function parseGroupJoinToken(token: string): string {
  const normalized = token.trim();
  if (
    !normalized.startsWith(GROUP_JOIN_TOKEN_MARKER) ||
    normalized.length <= GROUP_JOIN_TOKEN_MARKER.length
  ) {
    throw new AppError({
      code: "GROUP_JOIN_TOKEN_INVALID",
      message: "Group join token is invalid",
      status: 400,
      expose: true,
    });
  }

  return normalized;
}

export function deriveGroupJoinTokenLookupPrefix(token: string): string {
  const normalized = parseGroupJoinToken(token);
  const entropyPrefix = normalized.slice(
    GROUP_JOIN_TOKEN_MARKER.length,
    GROUP_JOIN_TOKEN_MARKER.length + GROUP_JOIN_TOKEN_LOOKUP_ENTROPY_LENGTH,
  );

  if (entropyPrefix.length === 0) {
    throw new AppError({
      code: "GROUP_JOIN_TOKEN_INVALID",
      message: "Group join token is invalid",
      status: 400,
      expose: true,
    });
  }

  return `${GROUP_JOIN_TOKEN_MARKER}${entropyPrefix}`;
}

export async function hashGroupJoinToken(token: string): Promise<string> {
  const normalized = parseGroupJoinToken(token);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalized),
  );

  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export function generateGroupJoinToken(): string {
  const randomBytes = crypto.getRandomValues(
    new Uint8Array(GROUP_JOIN_TOKEN_RANDOM_BYTES_LENGTH),
  );
  return `${GROUP_JOIN_TOKEN_MARKER}${encodeBase64url(randomBytes)}`;
}
