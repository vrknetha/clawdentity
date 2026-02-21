import { generateUlid, makeAgentDid } from "@clawdentity/protocol";
import {
  addSeconds,
  nowIso,
  type RegistryConfig,
  toIso,
} from "@clawdentity/sdk";
import {
  DAY_IN_SECONDS,
  DEFAULT_AGENT_FRAMEWORK,
  DEFAULT_AGENT_TTL_DAYS,
  MAX_AGENT_TTL_DAYS,
  MIN_AGENT_TTL_DAYS,
} from "./constants.js";
import { parseAgentRegistrationBody } from "./parsing.js";
import type {
  AgentRegistrationBody,
  AgentRegistrationResult,
  AgentReissueResult,
} from "./types.js";

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
