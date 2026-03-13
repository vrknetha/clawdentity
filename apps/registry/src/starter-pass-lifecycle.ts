import { encodeBase64url } from "@clawdentity/protocol";
import {
  AppError,
  addSeconds,
  type RegistryConfig,
  shouldExposeVerboseErrors,
  toIso,
} from "@clawdentity/sdk";

export const STARTER_PASS_CODE_PREFIX = "clw_stp_";
const STARTER_PASS_RANDOM_BYTES = 24;
const STARTER_PASS_TTL_SECONDS = 30 * 60;
const MAX_STARTER_PASS_CODE_LENGTH = 128;
const MAX_GITHUB_LOGIN_LENGTH = 64;
const MAX_DISPLAY_NAME_LENGTH = 64;

type StarterPassRedeemPayload = {
  code: string;
  displayName: string;
  apiKeyName: string;
};

function starterPassRedeemInvalidError(options: {
  environment: RegistryConfig["ENVIRONMENT"];
  details?: {
    fieldErrors: Record<string, string[]>;
    formErrors: string[];
  };
}): AppError {
  const exposeDetails = shouldExposeVerboseErrors(options.environment);
  return new AppError({
    code: "STARTER_PASS_REDEEM_INVALID",
    message: exposeDetails
      ? "Starter pass redeem payload is invalid"
      : "Request could not be processed",
    status: 400,
    expose: exposeDetails,
    details: exposeDetails ? options.details : undefined,
  });
}

export function starterPassDisabledError(): AppError {
  return new AppError({
    code: "GITHUB_ONBOARDING_DISABLED",
    message: "GitHub starter-pass onboarding is disabled",
    status: 503,
    expose: true,
  });
}

export function starterPassAlreadyIssuedError(): AppError {
  return new AppError({
    code: "STARTER_PASS_ALREADY_ISSUED",
    message: "A GitHub starter pass has already been issued for this account",
    status: 409,
    expose: true,
  });
}

export function starterPassExpiredError(): AppError {
  return new AppError({
    code: "STARTER_PASS_EXPIRED",
    message: "Starter pass has expired",
    status: 400,
    expose: true,
  });
}

export function starterPassAlreadyUsedError(): AppError {
  return new AppError({
    code: "STARTER_PASS_ALREADY_USED",
    message: "Starter pass has already been redeemed",
    status: 409,
    expose: true,
  });
}

export function starterPassCodeInvalidError(): AppError {
  return new AppError({
    code: "STARTER_PASS_CODE_INVALID",
    message: "Starter pass code is invalid",
    status: 400,
    expose: true,
  });
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

export function parseStarterPassRedeemPayload(input: {
  payload: unknown;
  environment: RegistryConfig["ENVIRONMENT"];
}): StarterPassRedeemPayload {
  if (
    typeof input.payload !== "object" ||
    input.payload === null ||
    Array.isArray(input.payload)
  ) {
    throw starterPassRedeemInvalidError({
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
  } else if (code.length > MAX_STARTER_PASS_CODE_LENGTH) {
    fieldErrors.code = [
      `code must be at most ${MAX_STARTER_PASS_CODE_LENGTH} characters`,
    ];
  } else if (!code.startsWith(STARTER_PASS_CODE_PREFIX)) {
    fieldErrors.code = [`code must start with ${STARTER_PASS_CODE_PREFIX}`];
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

  const displayName = displayNameInput ?? "User";
  const apiKeyName = apiKeyNameInput ?? "starter-pass";

  if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    fieldErrors.displayName = [
      `displayName must be at most ${MAX_DISPLAY_NAME_LENGTH} characters`,
    ];
  } else if (hasControlChars(displayName)) {
    fieldErrors.displayName = ["displayName contains control characters"];
  }

  if (apiKeyName.length > MAX_DISPLAY_NAME_LENGTH) {
    fieldErrors.apiKeyName = [
      `apiKeyName must be at most ${MAX_DISPLAY_NAME_LENGTH} characters`,
    ];
  } else if (hasControlChars(apiKeyName)) {
    fieldErrors.apiKeyName = ["apiKeyName contains control characters"];
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw starterPassRedeemInvalidError({
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

export function generateStarterPassCode(): string {
  const bytes = crypto.getRandomValues(
    new Uint8Array(STARTER_PASS_RANDOM_BYTES),
  );
  return `${STARTER_PASS_CODE_PREFIX}${encodeBase64url(bytes)}`;
}

export function computeStarterPassExpiry(nowMs: number): string {
  return addSeconds(nowMs, STARTER_PASS_TTL_SECONDS);
}

export function isStarterPassExpired(input: {
  expiresAt: string;
  nowMs: number;
}): boolean {
  const expiresAtMs = Date.parse(input.expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return true;
  }

  return expiresAtMs <= input.nowMs;
}

export function normalizeGithubLogin(input: string): string {
  const login = input.trim();
  if (
    login.length === 0 ||
    login.length > MAX_GITHUB_LOGIN_LENGTH ||
    hasControlChars(login)
  ) {
    throw new AppError({
      code: "GITHUB_ONBOARDING_INVALID_PROFILE",
      message: "GitHub profile is invalid",
      status: 502,
      expose: true,
    });
  }

  return login;
}

export function normalizeStarterDisplayName(input: string): string {
  const displayName = input.trim();
  if (
    displayName.length === 0 ||
    displayName.length > MAX_DISPLAY_NAME_LENGTH ||
    hasControlChars(displayName)
  ) {
    return "GitHub User";
  }

  return displayName;
}

export function normalizeStarterPassStatus(options: {
  status: "active" | "redeemed" | "expired";
  expiresAt: string;
  nowMs: number;
}): "active" | "redeemed" | "expired" {
  if (options.status !== "active") {
    return options.status;
  }

  return isStarterPassExpired({
    expiresAt: options.expiresAt,
    nowMs: options.nowMs,
  })
    ? "expired"
    : "active";
}

export function issueStarterPassMetadata(input: {
  nowMs: number;
  displayName: string;
}) {
  return {
    code: generateStarterPassCode(),
    displayName: normalizeStarterDisplayName(input.displayName),
    expiresAt: toIso(computeStarterPassExpiry(input.nowMs)),
  };
}
