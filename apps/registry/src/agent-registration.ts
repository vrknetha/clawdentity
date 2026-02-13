import {
  type AitClaims,
  decodeBase64url,
  generateUlid,
  makeAgentDid,
  validateAgentName,
} from "@clawdentity/protocol";
import {
  AppError,
  addSeconds,
  nowIso,
  type RegistryConfig,
  shouldExposeVerboseErrors,
} from "@clawdentity/sdk";

const DEFAULT_AGENT_FRAMEWORK = "openclaw";
const DEFAULT_AGENT_TTL_DAYS = 30;
const MAX_FRAMEWORK_LENGTH = 32;
const MIN_AGENT_TTL_DAYS = 1;
const MAX_AGENT_TTL_DAYS = 90;
const DAY_IN_SECONDS = 24 * 60 * 60;
const ED25519_PUBLIC_KEY_LENGTH = 32;
const REGISTRY_ISSUER_BY_ENVIRONMENT: Record<
  RegistryConfig["ENVIRONMENT"],
  string
> = {
  development: "https://dev.api.clawdentity.com",
  production: "https://api.clawdentity.com",
  test: "https://dev.api.clawdentity.com",
};

type AgentRegistrationBody = {
  name: string;
  framework?: string;
  publicKey: string;
  ttlDays?: number;
};

export type AgentRegistrationResult = {
  agent: {
    id: string;
    did: string;
    ownerDid: string;
    name: string;
    framework: string;
    publicKey: string;
    currentJti: string;
    ttlDays: number;
    status: "active";
    expiresAt: string;
    createdAt: string;
    updatedAt: string;
  };
  claims: AitClaims;
};

export type AgentReissueResult = {
  agent: {
    id: string;
    did: string;
    ownerDid: string;
    name: string;
    framework: string;
    publicKey: string;
    currentJti: string;
    ttlDays: number;
    status: "active";
    expiresAt: string;
    updatedAt: string;
  };
  claims: AitClaims;
};

function invalidRegistration(options: {
  environment: RegistryConfig["ENVIRONMENT"];
  details?: {
    fieldErrors: Record<string, string[]>;
    formErrors: string[];
  };
}): AppError {
  const exposeDetails = shouldExposeVerboseErrors(options.environment);
  return new AppError({
    code: "AGENT_REGISTRATION_INVALID",
    message: exposeDetails
      ? "Agent registration payload is invalid"
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
  };

  if (Object.keys(fieldErrors).length > 0) {
    throw invalidRegistration({
      environment,
      details: { fieldErrors, formErrors: [] },
    });
  }

  return parsed;
}

export function buildAgentRegistration(input: {
  payload: unknown;
  ownerDid: string;
  issuer: string;
  environment: RegistryConfig["ENVIRONMENT"];
}): AgentRegistrationResult {
  const parsedBody = parseAgentRegistrationBody(
    input.payload,
    input.environment,
  );

  const issuedAt = nowIso();
  const issuedAtMs = Date.parse(issuedAt);
  const issuedAtSeconds = Math.floor(issuedAtMs / 1000);
  const ttlDays = parsedBody.ttlDays ?? DEFAULT_AGENT_TTL_DAYS;
  const framework = parsedBody.framework ?? DEFAULT_AGENT_FRAMEWORK;
  const ttlSeconds = ttlDays * DAY_IN_SECONDS;
  const expiresAt = addSeconds(issuedAt, ttlSeconds);

  const agentId = generateUlid(issuedAtMs);
  const agentDid = makeAgentDid(agentId);
  const currentJti = generateUlid(issuedAtMs + 1);
  const createdAt = issuedAt;

  return {
    agent: {
      id: agentId,
      did: agentDid,
      ownerDid: input.ownerDid,
      name: parsedBody.name,
      framework,
      publicKey: parsedBody.publicKey,
      currentJti,
      ttlDays,
      status: "active",
      expiresAt,
      createdAt,
      updatedAt: createdAt,
    },
    claims: {
      iss: input.issuer,
      sub: agentDid,
      ownerDid: input.ownerDid,
      name: parsedBody.name,
      framework,
      cnf: {
        jwk: {
          kty: "OKP",
          crv: "Ed25519",
          x: parsedBody.publicKey,
        },
      },
      iat: issuedAtSeconds,
      nbf: issuedAtSeconds,
      exp: issuedAtSeconds + ttlSeconds,
      jti: currentJti,
    },
  };
}

function resolveReissueExpiry(input: {
  previousExpiresAt: string | null;
  issuedAt: string;
  issuedAtMs: number;
  issuedAtSeconds: number;
}): {
  expiresAt: string;
  exp: number;
  ttlDays: number;
} {
  const defaultTtlSeconds = DEFAULT_AGENT_TTL_DAYS * DAY_IN_SECONDS;
  const defaultExp = input.issuedAtSeconds + defaultTtlSeconds;
  const defaultExpiry = addSeconds(input.issuedAt, defaultTtlSeconds);

  if (!input.previousExpiresAt) {
    return {
      expiresAt: defaultExpiry,
      exp: defaultExp,
      ttlDays: DEFAULT_AGENT_TTL_DAYS,
    };
  }

  const previousExpiryMs = Date.parse(input.previousExpiresAt);
  if (
    !Number.isFinite(previousExpiryMs) ||
    previousExpiryMs <= input.issuedAtMs
  ) {
    return {
      expiresAt: defaultExpiry,
      exp: defaultExp,
      ttlDays: DEFAULT_AGENT_TTL_DAYS,
    };
  }

  const previousExpirySeconds = Math.floor(previousExpiryMs / 1000);
  const remainingSeconds = Math.max(
    1,
    previousExpirySeconds - input.issuedAtSeconds,
  );
  const ttlDays = Math.min(
    MAX_AGENT_TTL_DAYS,
    Math.max(MIN_AGENT_TTL_DAYS, Math.ceil(remainingSeconds / DAY_IN_SECONDS)),
  );

  return {
    expiresAt: new Date(previousExpiryMs).toISOString(),
    exp: previousExpirySeconds,
    ttlDays,
  };
}

export function buildAgentReissue(input: {
  id: string;
  did: string;
  ownerDid: string;
  name: string;
  framework: string | null;
  publicKey: string;
  previousExpiresAt: string | null;
  issuer: string;
}): AgentReissueResult {
  const issuedAt = nowIso();
  const issuedAtMs = Date.parse(issuedAt);
  const issuedAtSeconds = Math.floor(issuedAtMs / 1000);
  const expiry = resolveReissueExpiry({
    previousExpiresAt: input.previousExpiresAt,
    issuedAt,
    issuedAtMs,
    issuedAtSeconds,
  });
  const currentJti = generateUlid(issuedAtMs + 1);
  const framework = input.framework ?? DEFAULT_AGENT_FRAMEWORK;

  return {
    agent: {
      id: input.id,
      did: input.did,
      ownerDid: input.ownerDid,
      name: input.name,
      framework,
      publicKey: input.publicKey,
      currentJti,
      ttlDays: expiry.ttlDays,
      status: "active",
      expiresAt: expiry.expiresAt,
      updatedAt: issuedAt,
    },
    claims: {
      iss: input.issuer,
      sub: input.did,
      ownerDid: input.ownerDid,
      name: input.name,
      framework,
      cnf: {
        jwk: {
          kty: "OKP",
          crv: "Ed25519",
          x: input.publicKey,
        },
      },
      iat: issuedAtSeconds,
      nbf: issuedAtSeconds,
      exp: expiry.exp,
      jti: currentJti,
    },
  };
}

export {
  DEFAULT_AGENT_FRAMEWORK,
  DEFAULT_AGENT_TTL_DAYS,
  MAX_AGENT_TTL_DAYS,
  MIN_AGENT_TTL_DAYS,
};

export function resolveRegistryIssuer(
  environment: RegistryConfig["ENVIRONMENT"],
): string {
  return REGISTRY_ISSUER_BY_ENVIRONMENT[environment];
}
