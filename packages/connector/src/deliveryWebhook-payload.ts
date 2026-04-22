import type { DeliveryWebhookSenderProfile } from "./deliveryWebhook-headers.js";

export type DeliveryWebhookHookPayloadInput = {
  contentType?: string;
  conversationId?: string;
  deliverySource?: string;
  deliveryTimestamp?: string;
  groupName?: string;
  groupId?: string;
  payload: unknown;
  replyTo?: string;
  requestId: string;
  senderDid: string;
  senderProfile?: DeliveryWebhookSenderProfile;
  toAgentDid: string;
};

function parseOptionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveSenderAgentName(input: {
  payload: unknown;
  senderProfile?: DeliveryWebhookSenderProfile;
}): string | undefined {
  return (
    parseOptionalNonEmptyString(input.senderProfile?.agentName) ??
    (isRecord(input.payload)
      ? parseOptionalNonEmptyString(input.payload.senderAgentName)
      : undefined)
  );
}

function resolveSenderDisplayName(input: {
  payload: unknown;
  senderProfile?: DeliveryWebhookSenderProfile;
}): string | undefined {
  return (
    parseOptionalNonEmptyString(input.senderProfile?.displayName) ??
    (isRecord(input.payload)
      ? parseOptionalNonEmptyString(input.payload.senderDisplayName)
      : undefined)
  );
}

function resolveGroupName(input: {
  groupName?: string;
  groupId?: string;
  payload: unknown;
}): string | undefined {
  return (
    parseOptionalNonEmptyString(input.groupName) ??
    (isRecord(input.payload)
      ? parseOptionalNonEmptyString(input.payload.groupName)
      : undefined) ??
    parseOptionalNonEmptyString(input.groupId)
  );
}

export function buildDeliveryWebhookHookPayload(
  input: DeliveryWebhookHookPayloadInput,
): unknown {
  const senderAgentName = resolveSenderAgentName({
    payload: input.payload,
    senderProfile: input.senderProfile,
  });
  const senderDisplayName = resolveSenderDisplayName({
    payload: input.payload,
    senderProfile: input.senderProfile,
  });
  const groupId = parseOptionalNonEmptyString(input.groupId);
  const groupName = resolveGroupName({
    groupName: input.groupName,
    groupId,
    payload: input.payload,
  });
  const conversationId = parseOptionalNonEmptyString(input.conversationId);
  const deliveryTimestamp = parseOptionalNonEmptyString(
    input.deliveryTimestamp,
  );
  const deliverySource = parseOptionalNonEmptyString(input.deliverySource);
  const contentType = parseOptionalNonEmptyString(input.contentType);
  const replyTo = parseOptionalNonEmptyString(input.replyTo);

  const relayMetadata: Record<string, unknown> = {};
  if (deliveryTimestamp !== undefined) {
    relayMetadata.timestamp = deliveryTimestamp;
  }
  if (deliverySource !== undefined) {
    relayMetadata.deliverySource = deliverySource;
  }
  if (contentType !== undefined) {
    relayMetadata.contentType = contentType;
  }
  if (replyTo !== undefined) {
    relayMetadata.replyTo = replyTo;
  }
  if (groupName !== undefined) {
    relayMetadata.groupName = groupName;
  }

  const payload: Record<string, unknown> = {
    type: "clawdentity.delivery.v1",
    requestId: input.requestId,
    fromAgentDid: input.senderDid,
    toAgentDid: input.toAgentDid,
    payload: input.payload ?? null,
  };
  if (conversationId !== undefined) {
    payload.conversationId = conversationId;
  }
  if (groupId !== undefined) {
    payload.groupId = groupId;
  }
  if (senderAgentName !== undefined) {
    payload.senderAgentName = senderAgentName;
  }
  if (senderDisplayName !== undefined) {
    payload.senderDisplayName = senderDisplayName;
  }
  if (Object.keys(relayMetadata).length > 0) {
    payload.relayMetadata = relayMetadata;
  }

  return payload;
}
