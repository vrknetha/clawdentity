import { parseGroupId } from "@clawdentity/protocol";
import type {
  RelayDeliveryInput,
  RelayReceiptLookupInput,
  RelayReceiptRecordInput,
} from "./types.js";

export function parseDeliveryInput(value: unknown): RelayDeliveryInput {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Relay delivery input must be an object");
  }

  const input = value as Partial<RelayDeliveryInput>;
  if (
    typeof input.requestId !== "string" ||
    typeof input.senderAgentDid !== "string" ||
    typeof input.recipientAgentDid !== "string"
  ) {
    throw new TypeError("Relay delivery input is invalid");
  }

  if (
    input.replyTo !== undefined &&
    (typeof input.replyTo !== "string" || input.replyTo.trim().length === 0)
  ) {
    throw new TypeError("Relay delivery input is invalid");
  }
  if (typeof input.replyTo === "string") {
    try {
      new URL(input.replyTo);
    } catch {
      throw new TypeError("Relay delivery input is invalid");
    }
  }
  if (typeof input.groupId === "string" && input.groupId.trim().length > 0) {
    try {
      parseGroupId(input.groupId.trim());
    } catch {
      throw new TypeError("Relay delivery input is invalid");
    }
  } else if (input.groupId !== undefined) {
    throw new TypeError("Relay delivery input is invalid");
  }

  return {
    requestId: input.requestId,
    senderAgentDid: input.senderAgentDid,
    recipientAgentDid: input.recipientAgentDid,
    payload: input.payload,
    deliverySource:
      typeof input.deliverySource === "string" &&
      input.deliverySource.trim().length > 0
        ? input.deliverySource.trim()
        : undefined,
    groupId:
      typeof input.groupId === "string" && input.groupId.trim().length > 0
        ? input.groupId.trim()
        : undefined,
    conversationId:
      typeof input.conversationId === "string" &&
      input.conversationId.trim().length > 0
        ? input.conversationId.trim()
        : undefined,
    replyTo:
      typeof input.replyTo === "string" && input.replyTo.trim().length > 0
        ? input.replyTo.trim()
        : undefined,
  };
}

export function parseReceiptRecordInput(
  value: unknown,
): RelayReceiptRecordInput {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Relay receipt input must be an object");
  }

  const input = value as Partial<RelayReceiptRecordInput>;
  if (
    typeof input.requestId !== "string" ||
    input.requestId.trim().length === 0 ||
    typeof input.senderAgentDid !== "string" ||
    input.senderAgentDid.trim().length === 0 ||
    typeof input.recipientAgentDid !== "string" ||
    input.recipientAgentDid.trim().length === 0
  ) {
    throw new TypeError("Relay receipt input is invalid");
  }

  if (
    input.status !== "delivered_to_webhook" &&
    input.status !== "dead_lettered"
  ) {
    throw new TypeError("Relay receipt input is invalid");
  }

  return {
    requestId: input.requestId.trim(),
    senderAgentDid: input.senderAgentDid.trim(),
    recipientAgentDid: input.recipientAgentDid.trim(),
    status: input.status,
    reason:
      typeof input.reason === "string" && input.reason.trim().length > 0
        ? input.reason.trim()
        : undefined,
  };
}

export function parseReceiptLookupInput(
  value: unknown,
): RelayReceiptLookupInput {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Relay receipt lookup input must be an object");
  }

  const input = value as Partial<RelayReceiptLookupInput>;
  if (
    typeof input.requestId !== "string" ||
    input.requestId.trim().length === 0 ||
    typeof input.senderAgentDid !== "string" ||
    input.senderAgentDid.trim().length === 0
  ) {
    throw new TypeError("Relay receipt lookup input is invalid");
  }

  return {
    requestId: input.requestId.trim(),
    senderAgentDid: input.senderAgentDid.trim(),
  };
}
