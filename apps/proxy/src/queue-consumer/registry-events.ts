import {
  AGENT_AUTH_REVOKED_EVENT_TYPE,
  AGENT_AUTH_REVOKED_REASON_AGENT_REVOKED,
  parseAgentAuthRevokedMetadata,
} from "@clawdentity/protocol";
import type { EventEnvelope } from "@clawdentity/sdk";
import {
  createDurableProxyTrustStore,
  type ProxyTrustStateNamespace,
} from "../proxy-trust-store.js";

export { AGENT_AUTH_REVOKED_EVENT_TYPE };

type RegistryRevocationEventData = {
  reason?: unknown;
  metadata?: unknown;
};

export type RegistryRevocationEvent =
  EventEnvelope<RegistryRevocationEventData>;

export type ParsedRegistryRevocationEvent = {
  event: RegistryRevocationEvent;
  agentDid: string;
};

export function parseRegistryRevocationEvent(
  payload: unknown,
): ParsedRegistryRevocationEvent | null {
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
  if (reason !== AGENT_AUTH_REVOKED_REASON_AGENT_REVOKED) {
    return null;
  }

  const { agentDid } = parseAgentAuthRevokedMetadata(
    (event.data as { metadata?: unknown }).metadata,
  );

  return {
    event: event as RegistryRevocationEvent,
    agentDid,
  };
}

export async function handleRegistryRevocationEvent(input: {
  agentDid: string;
  trustStateNamespace: ProxyTrustStateNamespace;
}): Promise<void> {
  const trustStore = createDurableProxyTrustStore(input.trustStateNamespace);
  await trustStore.markAgentRevoked(input.agentDid);
}
