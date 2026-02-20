import type { AitClaims } from "@clawdentity/protocol";

export type AgentRegistrationBody = {
  name: string;
  framework?: string;
  publicKey: string;
  ttlDays?: number;
  challengeId: string;
  challengeSignature: string;
};

export type AgentRegistrationChallengeBody = {
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
