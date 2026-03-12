import {
  AGENT_REGISTRATION_CHALLENGE_PATH,
  canonicalizeAgentRegistrationProof,
} from "@clawdentity/protocol";
import { encodeEd25519SignatureBase64url, signEd25519 } from "@clawdentity/sdk";
import type {
  AgentRegistrationChallengeResponse,
  AgentRegistrationResponse,
} from "./types.js";
import {
  extractRegistryErrorMessage,
  parseAgentRegistrationChallengeResponse,
  parseAgentRegistrationResponse,
  parseJsonResponse,
} from "./validation.js";

const toRegistryAgentsRequestUrl = (
  registryUrl: string,
  agentId?: string,
): string => {
  const normalizedBaseUrl = registryUrl.endsWith("/")
    ? registryUrl
    : `${registryUrl}/`;

  const path = agentId
    ? `v1/agents/${encodeURIComponent(agentId)}`
    : "v1/agents";

  return new URL(path, normalizedBaseUrl).toString();
};

const toRegistryAgentChallengeRequestUrl = (registryUrl: string): string => {
  const normalizedBaseUrl = registryUrl.endsWith("/")
    ? registryUrl
    : `${registryUrl}/`;

  return new URL(
    AGENT_REGISTRATION_CHALLENGE_PATH.slice(1),
    normalizedBaseUrl,
  ).toString();
};

const toHttpErrorMessage = (status: number, responseBody: unknown): string => {
  const registryMessage = extractRegistryErrorMessage(responseBody);

  if (status === 401) {
    return registryMessage
      ? `Registry authentication failed (401): ${registryMessage}`
      : "Registry authentication failed (401). Check your API key.";
  }

  if (status === 400) {
    return registryMessage
      ? `Registry rejected the request (400): ${registryMessage}`
      : "Registry rejected the request (400). Check name/framework/ttl-days.";
  }

  if (status >= 500) {
    return `Registry server error (${status}). Try again later.`;
  }

  if (registryMessage) {
    return `Registry request failed (${status}): ${registryMessage}`;
  }

  return `Registry request failed (${status})`;
};

const toRevokeHttpErrorMessage = (
  status: number,
  responseBody: unknown,
): string => {
  const registryMessage = extractRegistryErrorMessage(responseBody);

  if (status === 401) {
    return registryMessage
      ? `Registry authentication failed (401): ${registryMessage}`
      : "Registry authentication failed (401). Check your API key.";
  }

  if (status === 404) {
    return registryMessage
      ? `Agent not found (404): ${registryMessage}`
      : "Agent not found in the registry (404).";
  }

  if (status === 409) {
    return registryMessage
      ? `Agent cannot be revoked (409): ${registryMessage}`
      : "Agent cannot be revoked (409).";
  }

  if (status >= 500) {
    return `Registry server error (${status}). Try again later.`;
  }

  if (registryMessage) {
    return `Registry request failed (${status}): ${registryMessage}`;
  }

  return `Registry request failed (${status})`;
};

const requestAgentRegistrationChallenge = async (input: {
  apiKey: string;
  registryUrl: string;
  publicKey: string;
}): Promise<AgentRegistrationChallengeResponse> => {
  let response: Response;
  try {
    response = await fetch(
      toRegistryAgentChallengeRequestUrl(input.registryUrl),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          publicKey: input.publicKey,
        }),
      },
    );
  } catch {
    throw new Error(
      "Unable to connect to the registry. Check network access and registryUrl.",
    );
  }

  const responseBody = await parseJsonResponse(response);

  if (!response.ok) {
    throw new Error(toHttpErrorMessage(response.status, responseBody));
  }

  return parseAgentRegistrationChallengeResponse(responseBody);
};

export const registerAgent = async (input: {
  apiKey: string;
  registryUrl: string;
  name: string;
  publicKey: string;
  secretKey: Uint8Array;
  framework?: string;
  ttlDays?: number;
}): Promise<AgentRegistrationResponse> => {
  const challenge = await requestAgentRegistrationChallenge({
    apiKey: input.apiKey,
    registryUrl: input.registryUrl,
    publicKey: input.publicKey,
  });

  const canonicalProof = canonicalizeAgentRegistrationProof({
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    ownerDid: challenge.ownerDid,
    publicKey: input.publicKey,
    name: input.name,
    framework: input.framework,
    ttlDays: input.ttlDays,
  });
  const challengeSignature = encodeEd25519SignatureBase64url(
    await signEd25519(
      new TextEncoder().encode(canonicalProof),
      input.secretKey,
    ),
  );

  const requestBody: {
    name: string;
    publicKey: string;
    challengeId: string;
    challengeSignature: string;
    framework?: string;
    ttlDays?: number;
  } = {
    name: input.name,
    publicKey: input.publicKey,
    challengeId: challenge.challengeId,
    challengeSignature,
  };

  if (input.framework) {
    requestBody.framework = input.framework;
  }

  if (input.ttlDays !== undefined) {
    requestBody.ttlDays = input.ttlDays;
  }

  let response: Response;
  try {
    response = await fetch(toRegistryAgentsRequestUrl(input.registryUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });
  } catch {
    throw new Error(
      "Unable to connect to the registry. Check network access and registryUrl.",
    );
  }

  const responseBody = await parseJsonResponse(response);

  if (!response.ok) {
    throw new Error(toHttpErrorMessage(response.status, responseBody));
  }

  return parseAgentRegistrationResponse(responseBody);
};

export const revokeAgent = async (input: {
  apiKey: string;
  registryUrl: string;
  agentId: string;
}): Promise<void> => {
  let response: Response;
  try {
    response = await fetch(
      toRegistryAgentsRequestUrl(input.registryUrl, input.agentId),
      {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${input.apiKey}`,
        },
      },
    );
  } catch {
    throw new Error(
      "Unable to connect to the registry. Check network access and registryUrl.",
    );
  }

  const responseBody = await parseJsonResponse(response);

  if (!response.ok) {
    throw new Error(toRevokeHttpErrorMessage(response.status, responseBody));
  }
};
