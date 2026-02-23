// Shared fake DB types used by server test helpers.
export type FakeD1Row = {
  apiKeyId: string;
  keyPrefix: string;
  keyHash: string;
  apiKeyStatus: "active" | "revoked";
  apiKeyName: string;
  humanId: string;
  humanDid: string;
  humanDisplayName: string;
  humanRole: "admin" | "user";
  humanStatus: "active" | "suspended";
};

export type FakeHumanRow = {
  id: string;
  did: string;
  displayName: string;
  role: "admin" | "user";
  status: "active" | "suspended";
  createdAt: string;
  updatedAt: string;
};

export type FakeApiKeyRow = {
  id: string;
  humanId: string;
  keyHash: string;
  keyPrefix: string;
  name: string;
  status: "active" | "revoked";
  createdAt: string;
  lastUsedAt: string | null;
};

export type FakeInternalServiceRow = {
  id: string;
  name: string;
  secretHash: string;
  secretPrefix: string;
  scopesJson: string;
  status: "active" | "revoked";
  createdBy: string;
  rotatedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type FakeAgentAuthSessionRow = {
  id: string;
  agentId: string;
  refreshKeyHash: string;
  refreshKeyPrefix: string;
  refreshIssuedAt: string;
  refreshExpiresAt: string;
  refreshLastUsedAt: string | null;
  accessKeyHash: string;
  accessKeyPrefix: string;
  accessIssuedAt: string;
  accessExpiresAt: string;
  accessLastUsedAt: string | null;
  status: "active" | "revoked";
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type FakeAgentAuthEventInsertRow = Record<string, unknown>;
export type FakeAgentAuthSessionInsertRow = Record<string, unknown>;
export type FakeAgentAuthSessionUpdateRow = Record<string, unknown>;
export type FakeApiKeySelectRow = {
  id: string;
  human_id: string;
  key_hash: string;
  key_prefix: string;
  name: string;
  status: "active" | "revoked";
  created_at: string;
  last_used_at: string | null;
};

export type FakeAgentInsertRow = Record<string, unknown>;
export type FakeHumanInsertRow = Record<string, unknown>;
export type FakeApiKeyInsertRow = Record<string, unknown>;
export type FakeInternalServiceInsertRow = Record<string, unknown>;
export type FakeAgentUpdateRow = Record<string, unknown>;
export type FakeRevocationInsertRow = Record<string, unknown>;
export type FakeAgentRegistrationChallengeInsertRow = Record<string, unknown>;
export type FakeAgentRegistrationChallengeUpdateRow = Record<string, unknown>;
export type FakeInviteInsertRow = Record<string, unknown>;
export type FakeInviteUpdateRow = Record<string, unknown>;
export type FakeRevocationRow = {
  id: string;
  jti: string;
  agentId: string;
  reason: string | null;
  revokedAt: string;
};
export type FakeAgentRow = {
  id: string;
  did: string;
  ownerId: string;
  name: string;
  framework: string | null;
  publicKey?: string;
  status: "active" | "revoked";
  expiresAt: string | null;
  currentJti?: string | null;
  createdAt?: string;
  updatedAt?: string;
};
export type FakeAgentRegistrationChallengeRow = {
  id: string;
  ownerId: string;
  publicKey: string;
  nonce: string;
  status: "pending" | "used";
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
export type FakeInviteRow = {
  id: string;
  code: string;
  createdBy: string;
  redeemedBy: string | null;
  agentId: string | null;
  expiresAt: string | null;
  createdAt: string;
};

export type FakeAgentSelectRow = {
  id: string;
  did: string;
  owner_id: string;
  owner_did: string;
  name: string;
  framework: string | null;
  public_key: string;
  status: "active" | "revoked";
  expires_at: string | null;
  current_jti: string | null;
  created_at: string;
  updated_at: string;
};

export type FakeDbOptions = {
  beforeFirstAgentUpdate?: (agentRows: FakeAgentRow[]) => void;
  beforeFirstAgentAuthSessionUpdate?: (
    sessionRows: FakeAgentAuthSessionRow[],
  ) => void;
  failApiKeyInsertCount?: number;
  failInternalServiceInsertCount?: number;
  failBeginTransaction?: boolean;
  internalServiceRows?: FakeInternalServiceRow[];
  inviteRows?: FakeInviteRow[];
  revocationRows?: FakeRevocationRow[];
  registrationChallengeRows?: FakeAgentRegistrationChallengeRow[];
  agentAuthSessionRows?: FakeAgentAuthSessionRow[];
};

export type FakeCrlSelectRow = {
  id: string;
  jti: string;
  reason: string | null;
  revoked_at: string;
  agent_did: string;
  did: string;
};

export type FakeDbState = {
  authRows: FakeD1Row[];
  agentRows: FakeAgentRow[];
  options: FakeDbOptions;
  updates: Array<{ lastUsedAt: string; apiKeyId: string }>;
  humanInserts: FakeHumanInsertRow[];
  apiKeyInserts: FakeApiKeyInsertRow[];
  internalServiceInserts: FakeInternalServiceInsertRow[];
  agentInserts: FakeAgentInsertRow[];
  agentUpdates: FakeAgentUpdateRow[];
  revocationInserts: FakeRevocationInsertRow[];
  agentRegistrationChallengeInserts: FakeAgentRegistrationChallengeInsertRow[];
  agentRegistrationChallengeUpdates: FakeAgentRegistrationChallengeUpdateRow[];
  agentAuthSessionInserts: FakeAgentAuthSessionInsertRow[];
  agentAuthSessionUpdates: FakeAgentAuthSessionUpdateRow[];
  agentAuthEventInserts: FakeAgentAuthEventInsertRow[];
  inviteInserts: FakeInviteInsertRow[];
  inviteUpdates: FakeInviteUpdateRow[];
  revocationRows: FakeRevocationRow[];
  registrationChallengeRows: FakeAgentRegistrationChallengeRow[];
  agentAuthSessionRows: FakeAgentAuthSessionRow[];
  inviteRows: FakeInviteRow[];
  humanRows: FakeHumanRow[];
  apiKeyRows: FakeApiKeyRow[];
  internalServiceRows: FakeInternalServiceRow[];
  beforeFirstAgentUpdateApplied: boolean;
  beforeFirstAgentAuthSessionUpdateApplied: boolean;
  remainingApiKeyInsertFailures: number;
  remainingInternalServiceInsertFailures: number;
};
