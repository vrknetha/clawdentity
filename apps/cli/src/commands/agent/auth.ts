import { refreshAgentAuthWithClawProof } from "@clawdentity/sdk";
import {
  readAgentAitToken,
  readAgentIdentity,
  readAgentRegistryAuth,
  readAgentSecretKey,
} from "./fs.js";
import { IDENTITY_FILE_NAME } from "./paths.js";
import type { AgentAuthBundle } from "./types.js";

export const refreshAgentAuth = async (input: {
  agentName: string;
}): Promise<{
  registryUrl: string;
  agentAuth: AgentAuthBundle;
}> => {
  const ait = await readAgentAitToken(input.agentName);
  const identity = await readAgentIdentity(input.agentName);
  const secretKey = await readAgentSecretKey(input.agentName);
  const localAuth = await readAgentRegistryAuth(input.agentName);

  const registryUrl = identity.registryUrl?.trim();
  if (!registryUrl) {
    throw new Error(
      `Agent "${input.agentName}" identity is missing registryUrl in ${IDENTITY_FILE_NAME}`,
    );
  }

  const agentAuth = await refreshAgentAuthWithClawProof({
    registryUrl,
    ait,
    secretKey,
    refreshToken: localAuth.refreshToken,
  });

  return {
    registryUrl,
    agentAuth,
  };
};
