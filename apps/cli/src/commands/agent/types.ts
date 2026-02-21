export type AgentCreateOptions = {
  framework?: string;
  ttlDays?: string;
};

export type AgentAuthBundle = {
  tokenType: "Bearer";
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
};

export type AgentRegistrationResponse = {
  agent: {
    did: string;
    name: string;
    framework: string;
    expiresAt: string;
  };
  ait: string;
  agentAuth: AgentAuthBundle;
};

export type AgentRegistrationChallengeResponse = {
  challengeId: string;
  nonce: string;
  ownerDid: string;
  expiresAt: string;
};

export type LocalAgentIdentity = {
  did: string;
  registryUrl?: string;
};

export type LocalAgentRegistryAuth = {
  refreshToken: string;
};

export type RegistryErrorEnvelope = {
  error?: {
    message?: string;
  };
};
