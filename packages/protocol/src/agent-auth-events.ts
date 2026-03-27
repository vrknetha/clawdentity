import { parseAgentDid } from "./did.js";

export const AGENT_AUTH_ISSUED_EVENT_TYPE = "agent.auth.issued";
export const AGENT_AUTH_REFRESHED_EVENT_TYPE = "agent.auth.refreshed";
export const AGENT_AUTH_REVOKED_EVENT_TYPE = "agent.auth.revoked";
export const AGENT_AUTH_REFRESH_REJECTED_EVENT_TYPE =
  "agent.auth.refresh_rejected";

export const AGENT_AUTH_REVOKED_REASON_AGENT_REVOKED = "agent_revoked";
export const AGENT_AUTH_REVOKED_METADATA_AGENT_DID_KEY = "agentDid";

export type AgentAuthRevokedMetadata = {
  agentDid: string;
};

export function createAgentAuthRevokedMetadata(
  agentDid: string,
): AgentAuthRevokedMetadata {
  const normalizedAgentDid = agentDid.trim();
  parseAgentDid(normalizedAgentDid);
  return {
    [AGENT_AUTH_REVOKED_METADATA_AGENT_DID_KEY]: normalizedAgentDid,
  };
}

export function parseAgentAuthRevokedMetadata(
  metadata: unknown,
): AgentAuthRevokedMetadata {
  if (typeof metadata !== "object" || metadata === null) {
    throw new Error("Registry revocation event metadata must be an object");
  }

  const agentDid = (metadata as { agentDid?: unknown })[
    AGENT_AUTH_REVOKED_METADATA_AGENT_DID_KEY
  ];
  if (typeof agentDid !== "string" || agentDid.trim().length === 0) {
    throw new Error(
      "Registry revocation event metadata must include a non-empty agentDid",
    );
  }

  const normalizedAgentDid = agentDid.trim();
  parseAgentDid(normalizedAgentDid);
  return {
    [AGENT_AUTH_REVOKED_METADATA_AGENT_DID_KEY]: normalizedAgentDid,
  };
}
