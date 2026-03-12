import {
  canonicalizeAgentRegistrationProof,
  decodeBase64url,
} from "@clawdentity/protocol";
import { nowUtcMs, type RegistryConfig, verifyEd25519 } from "@clawdentity/sdk";
import { registrationProofError } from "./errors.js";
import type {
  AgentRegistrationBody,
  PersistedAgentRegistrationChallenge,
} from "./types.js";

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
