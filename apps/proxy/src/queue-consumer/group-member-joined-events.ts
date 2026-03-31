import {
  createGroupMemberJoinedNotificationMessage,
  GROUP_MEMBER_JOINED_EVENT_TYPE,
  GROUP_MEMBER_JOINED_TRUSTED_DELIVERY_SOURCE,
  type GroupMemberJoinedEventData,
  parseGroupMemberJoinedEventData,
} from "@clawdentity/protocol";
import type { EventEnvelope } from "@clawdentity/sdk";
import {
  type AgentRelaySessionNamespace,
  deliverToRelaySession,
} from "../agent-relay-session.js";

export { GROUP_MEMBER_JOINED_EVENT_TYPE };

export type GroupMemberJoinedQueueEvent =
  EventEnvelope<GroupMemberJoinedEventData>;

function parseEventEnvelope(
  payload: unknown,
): EventEnvelope<Record<string, unknown>> {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new Error("Group member joined queue payload must be an object");
  }

  const event = payload as Partial<EventEnvelope<Record<string, unknown>>>;
  if (event.type !== GROUP_MEMBER_JOINED_EVENT_TYPE) {
    throw new Error("Unsupported group member joined event type");
  }
  if (typeof event.data !== "object" || event.data === null) {
    throw new Error(
      "Group member joined queue payload must include an object data field",
    );
  }

  return event as EventEnvelope<Record<string, unknown>>;
}

export function parseGroupMemberJoinedQueueEvent(
  payload: unknown,
): GroupMemberJoinedQueueEvent {
  const event = parseEventEnvelope(payload);
  const normalizedData = parseGroupMemberJoinedEventData(event.data);

  return {
    ...event,
    data: normalizedData,
  };
}

function buildGroupMemberJoinedRequestId(
  data: GroupMemberJoinedEventData,
): string {
  return [
    "group.member.joined",
    data.groupId,
    data.joinedAgentDid,
    data.recipientAgentDid,
    data.joinedAt,
  ].join(":");
}

function resolveRecipientRelaySession(input: {
  recipientAgentDid: string;
  relaySessionNamespace: AgentRelaySessionNamespace;
}) {
  return input.relaySessionNamespace.get(
    input.relaySessionNamespace.idFromName(input.recipientAgentDid),
  );
}

function toNotificationPayload(data: GroupMemberJoinedEventData) {
  const message =
    data.message ??
    createGroupMemberJoinedNotificationMessage({
      joinedAgentName: data.joinedAgentName,
      groupName: data.groupName,
    });

  return {
    type: "clawdentity:group-member-joined",
    event: GROUP_MEMBER_JOINED_EVENT_TYPE,
    message,
    groupId: data.groupId,
    groupName: data.groupName,
    joinedAgentDid: data.joinedAgentDid,
    joinedAgentName: data.joinedAgentName,
    role: data.role,
    joinedAt: data.joinedAt,
  };
}

export async function handleGroupMemberJoinedQueueEvent(input: {
  event: GroupMemberJoinedQueueEvent;
  relaySessionNamespace: AgentRelaySessionNamespace;
}): Promise<void> {
  const relaySession = resolveRecipientRelaySession({
    recipientAgentDid: input.event.data.recipientAgentDid,
    relaySessionNamespace: input.relaySessionNamespace,
  });

  await deliverToRelaySession(relaySession, {
    requestId: buildGroupMemberJoinedRequestId(input.event.data),
    senderAgentDid: input.event.data.joinedAgentDid,
    recipientAgentDid: input.event.data.recipientAgentDid,
    deliverySource: GROUP_MEMBER_JOINED_TRUSTED_DELIVERY_SOURCE,
    payload: toNotificationPayload(input.event.data),
  });
}
