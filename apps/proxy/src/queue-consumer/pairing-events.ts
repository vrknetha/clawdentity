import {
  PAIR_ACCEPTED_EVENT_TYPE,
  type PairAcceptedEvent,
  parsePairAcceptedEvent,
} from "@clawdentity/protocol";
import {
  type AgentRelaySessionNamespace,
  deliverToRelaySession,
} from "../agent-relay-session.js";

export { PAIR_ACCEPTED_EVENT_TYPE };

export type PairAcceptedQueueEvent = PairAcceptedEvent;

export function parsePairAcceptedQueueEvent(
  payload: unknown,
): PairAcceptedQueueEvent {
  return parsePairAcceptedEvent(payload);
}

function buildPairAcceptedRequestId(event: PairAcceptedQueueEvent): string {
  return [
    "pair.accepted",
    event.initiatorAgentDid,
    event.responderAgentDid,
    event.eventTimestampUtc,
  ].join(":");
}

function resolveInitiatorRelaySession(input: {
  initiatorAgentDid: string;
  relaySessionNamespace: AgentRelaySessionNamespace;
}) {
  return input.relaySessionNamespace.get(
    input.relaySessionNamespace.idFromName(input.initiatorAgentDid),
  );
}

function toSystemPayload(event: PairAcceptedQueueEvent): {
  system: PairAcceptedQueueEvent;
} {
  return {
    system: {
      type: PAIR_ACCEPTED_EVENT_TYPE,
      initiatorAgentDid: event.initiatorAgentDid,
      responderAgentDid: event.responderAgentDid,
      responderProfile: event.responderProfile,
      issuerProxyOrigin: event.issuerProxyOrigin,
      eventTimestampUtc: event.eventTimestampUtc,
    },
  };
}

export async function handlePairAcceptedQueueEvent(input: {
  event: PairAcceptedQueueEvent;
  relaySessionNamespace: AgentRelaySessionNamespace;
}): Promise<void> {
  const relaySession = resolveInitiatorRelaySession({
    initiatorAgentDid: input.event.initiatorAgentDid,
    relaySessionNamespace: input.relaySessionNamespace,
  });

  await deliverToRelaySession(relaySession, {
    requestId: buildPairAcceptedRequestId(input.event),
    senderAgentDid: input.event.responderAgentDid,
    recipientAgentDid: input.event.initiatorAgentDid,
    payload: toSystemPayload(input.event),
  });
}
