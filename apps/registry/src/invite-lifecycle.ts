import { encodeBase64url } from "@clawdentity/protocol";
import {
  AppError,
  type RegistryConfig,
  shouldExposeVerboseErrors,
  toIso,
} from "@clawdentity/sdk";

const DEFAULT_INVITE_REDEEM_DISPLAY_NAME = "User";
const DEFAULT_INVITE_REDEEM_API_KEY_NAME = "invite";
const MAX_DISPLAY_NAME_LENGTH = 64;
const MAX_API_KEY_NAME_LENGTH = 64;
const MAX_INVITE_CODE_LENGTH = 128;
const INVITE_CODE_PREFIX = "clw_inv_";
const INVITE_CODE_RANDOM_BYTES = 24;

type InviteCreatePayload = {
  expiresAt: string | null;
};

type InviteRedeemPayload = {
  code: string;
  displayName: string;
  apiKeyName: string;
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
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function inviteCreateInvalidError(options: {
  environment: RegistryConfig["ENVIRONMENT"];
  details?: {
    fieldErrors: Record<string, string[]>;
    formErrors: string[];
  };
}): AppError {
  const exposeDetails = shouldExposeVerboseErrors(options.environment);
  return new AppError({
    code: "INVITE_CREATE_INVALID",
    message: exposeDetails
      ? "Invite create payload is invalid"
      : "Request could not be processed",
    status: 400,
    expose: exposeDetails,
    details: exposeDetails ? options.details : undefined,
  });
}

function inviteRedeemInvalidError(options: {
  environment: RegistryConfig["ENVIRONMENT"];
  details?: {
    fieldErrors: Record<string, string[]>;
    formErrors: string[];
  };
}): AppError {
  const exposeDetails = shouldExposeVerboseErrors(options.environment);
  return new AppError({
    code: "INVITE_REDEEM_INVALID",
    message: exposeDetails
      ? "Invite redeem payload is invalid"
      : "Request could not be processed",
    status: 400,
    expose: exposeDetails,
    details: exposeDetails ? options.details : undefined,
  });
}

export function parseInviteCreatePayload(input: {
  payload: unknown;
  environment: RegistryConfig["ENVIRONMENT"];
  nowMs: number;
}): InviteCreatePayload {
  if (
    typeof input.payload !== "object" ||
    input.payload === null ||
    Array.isArray(input.payload)
  ) {
    throw inviteCreateInvalidError({
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

  if (
    payload.expiresAt !== undefined &&
    payload.expiresAt !== null &&
    typeof payload.expiresAt !== "string"
  ) {
    fieldErrors.expiresAt = ["expiresAt must be a string or null"];
  }

  let expiresAt: string | null = null;
  if (typeof payload.expiresAt === "string") {
    const expiresAtInput = payload.expiresAt.trim();
    if (expiresAtInput.length === 0) {
      fieldErrors.expiresAt = ["expiresAt must not be empty"];
    } else {
      const expiresAtMillis = Date.parse(expiresAtInput);
      if (!Number.isFinite(expiresAtMillis)) {
        fieldErrors.expiresAt = ["expiresAt must be a valid ISO-8601 datetime"];
      } else if (expiresAtMillis <= input.nowMs) {
        fieldErrors.expiresAt = ["expiresAt must be in the future"];
      } else {
        expiresAt = toIso(expiresAtMillis);
      }
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw inviteCreateInvalidError({
      environment: input.environment,
      details: { fieldErrors, formErrors: [] },
    });
  }

  return { expiresAt };
}

export function parseInviteRedeemPayload(input: {
  payload: unknown;
  environment: RegistryConfig["ENVIRONMENT"];
}): InviteRedeemPayload {
  if (
    typeof input.payload !== "object" ||
    input.payload === null ||
    Array.isArray(input.payload)
  ) {
    throw inviteRedeemInvalidError({
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

  if (typeof payload.code !== "string") {
    fieldErrors.code = ["code is required"];
  }

  const code = typeof payload.code === "string" ? payload.code.trim() : "";
  if (code.length === 0 && !fieldErrors.code) {
    fieldErrors.code = ["code is required"];
  } else if (code.length > MAX_INVITE_CODE_LENGTH) {
    fieldErrors.code = [
      `code must be at most ${MAX_INVITE_CODE_LENGTH} characters`,
    ];
  }

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
  if (
    payload.displayName !== undefined &&
    displayNameInput === undefined &&
    !fieldErrors.displayName
  ) {
    fieldErrors.displayName = ["displayName must not be empty"];
  }

  const apiKeyNameInput = parseOptionalTrimmedString(payload.apiKeyName);
  if (
    payload.apiKeyName !== undefined &&
    apiKeyNameInput === undefined &&
    !fieldErrors.apiKeyName
  ) {
    fieldErrors.apiKeyName = ["apiKeyName must not be empty"];
  }

  const displayName = displayNameInput ?? DEFAULT_INVITE_REDEEM_DISPLAY_NAME;
  const apiKeyName = apiKeyNameInput ?? DEFAULT_INVITE_REDEEM_API_KEY_NAME;

  if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    fieldErrors.displayName = [
      `displayName must be at most ${MAX_DISPLAY_NAME_LENGTH} characters`,
    ];
  } else if (hasControlChars(displayName)) {
    fieldErrors.displayName = ["displayName contains control characters"];
  }

  if (apiKeyName.length > MAX_API_KEY_NAME_LENGTH) {
    fieldErrors.apiKeyName = [
      `apiKeyName must be at most ${MAX_API_KEY_NAME_LENGTH} characters`,
    ];
  } else if (hasControlChars(apiKeyName)) {
    fieldErrors.apiKeyName = ["apiKeyName contains control characters"];
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw inviteRedeemInvalidError({
      environment: input.environment,
      details: { fieldErrors, formErrors: [] },
    });
  }

  return {
    code,
    displayName,
    apiKeyName,
  };
}

export function generateInviteCode(): string {
  const bytes = new Uint8Array(INVITE_CODE_RANDOM_BYTES);
  crypto.getRandomValues(bytes);
  return `${INVITE_CODE_PREFIX}${encodeBase64url(bytes)}`;
}

export function inviteCreateForbiddenError(): AppError {
  return new AppError({
    code: "INVITE_CREATE_FORBIDDEN",
    message: "Admin role is required",
    status: 403,
    expose: true,
  });
}

export function inviteRedeemCodeInvalidError(): AppError {
  return new AppError({
    code: "INVITE_REDEEM_CODE_INVALID",
    message: "Invite code is invalid",
    status: 400,
    expose: true,
  });
}

export function inviteRedeemExpiredError(): AppError {
  return new AppError({
    code: "INVITE_REDEEM_EXPIRED",
    message: "Invite code has expired",
    status: 400,
    expose: true,
  });
}

export function inviteRedeemAlreadyUsedError(): AppError {
  return new AppError({
    code: "INVITE_REDEEM_ALREADY_USED",
    message: "Invite code has already been redeemed",
    status: 409,
    expose: true,
  });
}
