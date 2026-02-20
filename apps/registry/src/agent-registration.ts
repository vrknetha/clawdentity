import {
  AGENT_REGISTRATION_PROOF_MESSAGE_TEMPLATE,
  type AitClaims,
  canonicalizeAgentRegistrationProof,
  decodeBase64url,
  encodeBase64url,
  generateUlid,
  makeAgentDid,
  parseUlid,
  validateAgentName,
} from "@clawdentity/protocol";
import {
  AppError,
  addSeconds,
  nowIso,
  nowUtcMs,
  type RegistryConfig,
  shouldExposeVerboseErrors,
  toIso,
  verifyEd25519,
} from "@clawdentity/sdk";

const DEFAULT_AGENT_FRAMEWORK = "openclaw";
const DEFAULT_AGENT_TTL_DAYS = 30;
const MAX_FRAMEWORK_LENGTH = 32;
const MIN_AGENT_TTL_DAYS = 1;
const MAX_AGENT_TTL_DAYS = 90;
const DAY_IN_SECONDS = 24 * 60 * 60;
const ED25519_PUBLIC_KEY_LENGTH = 32;
const ED25519_SIGNATURE_LENGTH = 64;
const AGENT_REGISTRATION_CHALLENGE_TTL_SECONDS = 5 * 60;
const AGENT_REGISTRATION_CHALLENGE_NONCE_LENGTH = 24;
const REGISTRY_ISSUER_BY_ENVIRONMENT: Record<
  RegistryConfig["ENVIRONMENT"],
  string
> = {
  development: "https://dev.registry.clawdentity.com",
  production: "https://registry.clawdentity.com",
  test: "https://dev.registry.clawdentity.com",
};

type AgentRegistrationBody = {
  name: string;
  framework?: string;
  publicKey: string;
  ttlDays?: number;
  challengeId: string;
  challengeSignature: string;
};

type AgentRegistrationChallengeBody = {
  publicKey: string;
};

export type AgentRegistrationChallenge = {
  id: string;
  ownerId: string;
  publicKey: string;
  nonce: string;
  status: "pending";
  expiresAt: string;
  usedAt: null;
  createdAt: string;
  updatedAt: string;
};

export type AgentRegistrationChallengeResult = {
  challenge: AgentRegistrationChallenge;
  response: {
    challengeId: string;
    nonce: string;
    ownerDid: string;
    expiresAt: string;
    algorithm: "Ed25519";
    messageTemplate: string;
  };
};

export type PersistedAgentRegistrationChallenge = {
  id: string;
  ownerId: string;
  publicKey: string;
  nonce: string;
  status: "pending" | "used";
  expiresAt: string;
  usedAt: string | null;
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

function invalidRegistrationChallenge(options: {
  environment: RegistryConfig["ENVIRONMENT"];
  details?: {
    fieldErrors: Record<string, string[]>;
    formErrors: string[];
  };
}): AppError {
  const exposeDetails = shouldExposeVerboseErrors(options.environment);
  return new AppError({
    code: "AGENT_REGISTRATION_CHALLENGE_INVALID",
    message: exposeDetails
      ? "Agent registration challenge payload is invalid"
      : "Request could not be processed",
    status: 400,
    expose: exposeDetails,
    details: exposeDetails ? options.details : undefined,
  });
}

function registrationProofError(options: {
  environment: RegistryConfig["ENVIRONMENT"];
  code:
    | "AGENT_REGISTRATION_CHALLENGE_EXPIRED"
    | "AGENT_REGISTRATION_CHALLENGE_REPLAYED"
    | "AGENT_REGISTRATION_PROOF_MISMATCH"
    | "AGENT_REGISTRATION_PROOF_INVALID";
  message: string;
}): AppError {
  const exposeDetails = shouldExposeVerboseErrors(options.environment);
  return new AppError({
    code: options.code,
    message: exposeDetails ? options.message : "Request could not be processed",
    status: 400,
    expose: true,
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

export function buildAgentRegistrationChallenge(input: {
  payload: unknown;
  ownerId: string;
  ownerDid: string;
  environment: RegistryConfig["ENVIRONMENT"];
}): AgentRegistrationChallengeResult {
  const parsedBody = parseAgentRegistrationChallengeBody(
    input.payload,
    input.environment,
  );

  const createdAt = nowIso();
  const createdAtMs = Date.parse(createdAt);
  const challengeId = generateUlid(createdAtMs);
  const nonceBytes = crypto.getRandomValues(
    new Uint8Array(AGENT_REGISTRATION_CHALLENGE_NONCE_LENGTH),
  );
  const nonce = encodeBase64url(nonceBytes);
  const expiresAt = addSeconds(
    createdAt,
    AGENT_REGISTRATION_CHALLENGE_TTL_SECONDS,
  );

  const challenge: AgentRegistrationChallenge = {
    id: challengeId,
    ownerId: input.ownerId,
    publicKey: parsedBody.publicKey,
    nonce,
    status: "pending",
    expiresAt,
    usedAt: null,
    createdAt,
    updatedAt: createdAt,
  };

  return {
    challenge,
    response: {
      challengeId,
      nonce,
      ownerDid: input.ownerDid,
      expiresAt,
      algorithm: "Ed25519",
      messageTemplate: AGENT_REGISTRATION_PROOF_MESSAGE_TEMPLATE,
    },
  };
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

export async function verifyAgentRegistrationOwnershipProof(input: {
  parsedBody: AgentRegistrationBody;
  challenge: PersistedAgentRegistrationChallenge;
  ownerDid: string;
  environment: RegistryConfig["ENVIRONMENT"];
}): Promise<void> {
  if (input.challenge.status !== "pending") {
    throw registrationProofError({
      environment: input.environment,
      code: "AGENT_REGISTRATION_CHALLENGE_REPLAYED",
      message: "Registration challenge has already been used",
    });
  }

  const expiresAtMs = Date.parse(input.challenge.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowUtcMs()) {
    throw registrationProofError({
      environment: input.environment,
      code: "AGENT_REGISTRATION_CHALLENGE_EXPIRED",
      message: "Registration challenge has expired",
    });
  }

  if (input.challenge.publicKey !== input.parsedBody.publicKey) {
    throw registrationProofError({
      environment: input.environment,
      code: "AGENT_REGISTRATION_PROOF_MISMATCH",
      message: "Registration challenge does not match the provided public key",
    });
  }

  let signatureBytes: Uint8Array;
  let publicKeyBytes: Uint8Array;
  try {
    signatureBytes = decodeBase64url(input.parsedBody.challengeSignature);
    publicKeyBytes = decodeBase64url(input.parsedBody.publicKey);
  } catch {
    throw registrationProofError({
      environment: input.environment,
      code: "AGENT_REGISTRATION_PROOF_INVALID",
      message: "Registration challenge signature is invalid",
    });
  }

  const canonical = canonicalizeAgentRegistrationProof({
    challengeId: input.challenge.id,
    nonce: input.challenge.nonce,
    ownerDid: input.ownerDid,
    publicKey: input.parsedBody.publicKey,
    name: input.parsedBody.name,
    framework: input.parsedBody.framework,
    ttlDays: input.parsedBody.ttlDays,
  });

  const verified = await verifyEd25519(
    signatureBytes,
    new TextEncoder().encode(canonical),
    publicKeyBytes,
  );

  if (!verified) {
    throw registrationProofError({
      environment: input.environment,
      code: "AGENT_REGISTRATION_PROOF_INVALID",
      message: "Registration challenge signature is invalid",
    });
  }
}

export function buildAgentRegistrationFromParsed(input: {
  parsedBody: AgentRegistrationBody;
  ownerDid: string;
  issuer: string;
}): AgentRegistrationResult {
  const issuedAt = nowIso();
  const issuedAtMs = Date.parse(issuedAt);
  const issuedAtSeconds = Math.floor(issuedAtMs / 1000);
  const ttlDays = input.parsedBody.ttlDays ?? DEFAULT_AGENT_TTL_DAYS;
  const framework = input.parsedBody.framework ?? DEFAULT_AGENT_FRAMEWORK;
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
      name: input.parsedBody.name,
      framework,
      publicKey: input.parsedBody.publicKey,
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
      name: input.parsedBody.name,
      framework,
      cnf: {
        jwk: {
          kty: "OKP",
          crv: "Ed25519",
          x: input.parsedBody.publicKey,
        },
      },
      iat: issuedAtSeconds,
      nbf: issuedAtSeconds,
      exp: issuedAtSeconds + ttlSeconds,
      jti: currentJti,
    },
  };
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

  return buildAgentRegistrationFromParsed({
    parsedBody,
    ownerDid: input.ownerDid,
    issuer: input.issuer,
  });
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
    expiresAt: toIso(previousExpiryMs),
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
  config: Pick<RegistryConfig, "ENVIRONMENT" | "REGISTRY_ISSUER_URL">,
): string {
  const explicitIssuer = config.REGISTRY_ISSUER_URL?.trim();
  if (explicitIssuer && explicitIssuer.length > 0) {
    return explicitIssuer;
  }

  return REGISTRY_ISSUER_BY_ENVIRONMENT[config.ENVIRONMENT];
}
