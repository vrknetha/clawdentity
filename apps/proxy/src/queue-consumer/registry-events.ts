import { parseAgentDid } from "@clawdentity/protocol";
import type { EventEnvelope } from "@clawdentity/sdk";
import {
  createDurableProxyTrustStore,
  type ProxyTrustStateNamespace,
} from "../proxy-trust-store.js";

export const AGENT_AUTH_REVOKED_EVENT_TYPE = "agent.auth.revoked";
const AGENT_REVOKED_REASON = "agent_revoked";

type RegistryRevocationEventData = {
  reason?: unknown;
  metadata?: unknown;
};

export type RegistryRevocationEvent =
  EventEnvelope<RegistryRevocationEventData>;

function parseRegistryRevocationMetadataAgentDid(metadata: unknown): string {
  if (typeof metadata !== "object" || metadata === null) {
    throw new Error("Registry revocation event metadata must be an object");
  }

  const agentDid = (metadata as { agentDid?: unknown }).agentDid;
  if (typeof agentDid !== "string" || agentDid.trim().length === 0) {
    throw new Error(
      "Registry revocation event metadata must include a non-empty agentDid",
    );
  }

  const normalizedAgentDid = agentDid.trim();
  parseAgentDid(normalizedAgentDid);
  return normalizedAgentDid;
}

export function parseRegistryRevocationEvent(
  payload: unknown,
): RegistryRevocationEvent | null {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new Error("Registry event payload must be an object");
  }

  const event = payload as Partial<RegistryRevocationEvent>;
  if (event.type !== AGENT_AUTH_REVOKED_EVENT_TYPE) {
    throw new Error("Unsupported registry event type");
  }

  if (typeof event.data !== "object" || event.data === null) {
    throw new Error("Registry event payload must include an object data field");
  }

  const reason = (event.data as { reason?: unknown }).reason;
  if (reason !== AGENT_REVOKED_REASON) {
    return null;
  }

  parseRegistryRevocationMetadataAgentDid(
    (event.data as { metadata?: unknown }).metadata,
  );

  return event as RegistryRevocationEvent;
}

export async function handleRegistryRevocationEvent(input: {
  event: RegistryRevocationEvent;
  trustStateNamespace: ProxyTrustStateNamespace;
}): Promise<void> {
  const trustStore = createDurableProxyTrustStore(input.trustStateNamespace);
  const agentDid = parseRegistryRevocationMetadataAgentDid(
    input.event.data.metadata,
  );
  await trustStore.markAgentRevoked(agentDid);
}
