import {
  decodeBase64url,
  parseUlid,
  validateAgentName,
} from "@clawdentity/protocol";
import type { RegistryConfig } from "@clawdentity/sdk";
import {
  ED25519_PUBLIC_KEY_LENGTH,
  ED25519_SIGNATURE_LENGTH,
  MAX_AGENT_TTL_DAYS,
  MAX_FRAMEWORK_LENGTH,
  MIN_AGENT_TTL_DAYS,
} from "./constants.js";
import { invalidRegistration, invalidRegistrationChallenge } from "./errors.js";
import type {
  AgentRegistrationBody,
  AgentRegistrationChallengeBody,
} from "./types.js";

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

function parseName(
  input: unknown,
  fieldErrors: Record<string, string[]>,
): string {
  if (typeof input !== "string") {
    addFieldError(fieldErrors, "name", "name is required");
    return "";
  }

  const value = input.trim();
  if (!validateAgentName(value)) {
    addFieldError(
      fieldErrors,
      "name",
      "name contains invalid characters or length",
    );
  }

  return value;
}

function parseFramework(
  input: unknown,
  fieldErrors: Record<string, string[]>,
): string | undefined {
  if (input === undefined) {
    return undefined;
  }

  if (typeof input !== "string") {
    addFieldError(fieldErrors, "framework", "framework must be a string");
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

function parsePublicKey(
  input: unknown,
  fieldErrors: Record<string, string[]>,
): string {
  if (typeof input !== "string") {
    addFieldError(fieldErrors, "publicKey", "publicKey is required");
    return "";
  }

  const value = input.trim();
  if (value.length === 0) {
    addFieldError(fieldErrors, "publicKey", "publicKey is required");
    return "";
  }

  let decodedKey: Uint8Array;
  try {
    decodedKey = decodeBase64url(value);
  } catch {
    addFieldError(
      fieldErrors,
      "publicKey",
      "publicKey must be a base64url-encoded 32-byte Ed25519 key",
    );
    return value;
  }

  if (decodedKey.length !== ED25519_PUBLIC_KEY_LENGTH) {
    addFieldError(
      fieldErrors,
      "publicKey",
      "publicKey must be a base64url-encoded 32-byte Ed25519 key",
    );
  }

  return value;
}

function parseTtlDays(
  input: unknown,
  fieldErrors: Record<string, string[]>,
): number | undefined {
  if (input === undefined) {
    return undefined;
  }

  if (typeof input !== "number" || !Number.isFinite(input)) {
    addFieldError(fieldErrors, "ttlDays", "ttlDays must be a number");
    return undefined;
  }

  if (!Number.isInteger(input)) {
    addFieldError(fieldErrors, "ttlDays", "ttlDays must be an integer");
    return undefined;
  }

  if (input < MIN_AGENT_TTL_DAYS || input > MAX_AGENT_TTL_DAYS) {
    addFieldError(
      fieldErrors,
      "ttlDays",
      `ttlDays must be between ${MIN_AGENT_TTL_DAYS} and ${MAX_AGENT_TTL_DAYS}`,
    );
    return undefined;
  }

  return input;
}

function parseChallengeId(
  input: unknown,
  fieldErrors: Record<string, string[]>,
): string {
  if (typeof input !== "string") {
    addFieldError(fieldErrors, "challengeId", "challengeId is required");
    return "";
  }

  const value = input.trim();
  if (value.length === 0) {
    addFieldError(fieldErrors, "challengeId", "challengeId is required");
    return "";
  }

  try {
    parseUlid(value);
  } catch {
    addFieldError(fieldErrors, "challengeId", "challengeId must be a ULID");
  }

  return value;
}

function parseChallengeSignature(
  input: unknown,
  fieldErrors: Record<string, string[]>,
): string {
  if (typeof input !== "string") {
    addFieldError(
      fieldErrors,
      "challengeSignature",
      "challengeSignature is required",
    );
    return "";
  }

  const value = input.trim();
  if (value.length === 0) {
    addFieldError(
      fieldErrors,
      "challengeSignature",
      "challengeSignature is required",
    );
    return "";
  }

  let decodedSignature: Uint8Array;
  try {
    decodedSignature = decodeBase64url(value);
  } catch {
    addFieldError(
      fieldErrors,
      "challengeSignature",
      "challengeSignature must be a base64url-encoded Ed25519 signature",
    );
    return value;
  }

  if (decodedSignature.length !== ED25519_SIGNATURE_LENGTH) {
    addFieldError(
      fieldErrors,
      "challengeSignature",
      "challengeSignature must be a base64url-encoded Ed25519 signature",
    );
  }

  return value;
}

export function parseAgentRegistrationChallengeBody(
  payload: unknown,
  environment: RegistryConfig["ENVIRONMENT"],
): AgentRegistrationChallengeBody {
  const fieldErrors: Record<string, string[]> = {};

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw invalidRegistrationChallenge({
      environment,
      details: {
        fieldErrors: {
          body: ["body must be a JSON object"],
        },
        formErrors: [],
      },
    });
  }

  const objectPayload = payload as Record<string, unknown>;
  const parsed: AgentRegistrationChallengeBody = {
    publicKey: parsePublicKey(objectPayload.publicKey, fieldErrors),
  };

  if (Object.keys(fieldErrors).length > 0) {
    throw invalidRegistrationChallenge({
      environment,
      details: { fieldErrors, formErrors: [] },
    });
  }

  return parsed;
}

export function parseAgentRegistrationBody(
  payload: unknown,
  environment: RegistryConfig["ENVIRONMENT"],
): AgentRegistrationBody {
  const fieldErrors: Record<string, string[]> = {};

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw invalidRegistration({
      environment,
      details: {
        fieldErrors: {
          body: ["body must be a JSON object"],
        },
        formErrors: [],
      },
    });
  }

  const objectPayload = payload as Record<string, unknown>;
  const parsed: AgentRegistrationBody = {
    name: parseName(objectPayload.name, fieldErrors),
    framework: parseFramework(objectPayload.framework, fieldErrors),
    publicKey: parsePublicKey(objectPayload.publicKey, fieldErrors),
    ttlDays: parseTtlDays(objectPayload.ttlDays, fieldErrors),
    challengeId: parseChallengeId(objectPayload.challengeId, fieldErrors),
    challengeSignature: parseChallengeSignature(
      objectPayload.challengeSignature,
      fieldErrors,
    ),
  };

  if (Object.keys(fieldErrors).length > 0) {
    throw invalidRegistration({
      environment,
      details: { fieldErrors, formErrors: [] },
    });
  }

  return parsed;
}
