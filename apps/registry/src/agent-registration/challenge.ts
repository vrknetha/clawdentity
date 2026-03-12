import {
  AGENT_REGISTRATION_PROOF_MESSAGE_TEMPLATE,
  encodeBase64url,
  generateUlid,
} from "@clawdentity/protocol";
import { addSeconds, nowIso, type RegistryConfig } from "@clawdentity/sdk";
import {
  AGENT_REGISTRATION_CHALLENGE_NONCE_LENGTH,
  AGENT_REGISTRATION_CHALLENGE_TTL_SECONDS,
} from "./constants.js";
import { parseAgentRegistrationChallengeBody } from "./parsing.js";
import type {
  AgentRegistrationChallenge,
  AgentRegistrationChallengeResult,
} from "./types.js";

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
