import {
  type AgentRelaySessionNamespace,
  recordRelayDeliveryReceipt,
} from "../agent-relay-session.js";

export const DELIVERY_RECEIPT_EVENT_TYPE = "delivery_receipt";

export type ReceiptQueueEvent = {
  type: typeof DELIVERY_RECEIPT_EVENT_TYPE;
  requestId: string;
  senderAgentDid: string;
  recipientAgentDid: string;
  status: "delivered_to_webhook" | "dead_lettered";
  reason?: string;
  processedAt?: string;
};

function ensureNonBlankString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing or invalid receipt queue field: ${field}`);
  }
  return value.trim();
}

export function parseReceiptQueueEvent(payload: unknown): ReceiptQueueEvent {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Receipt queue event payload must be an object");
  }
  const input = payload as Partial<ReceiptQueueEvent>;
  if (input.type !== DELIVERY_RECEIPT_EVENT_TYPE) {
    throw new Error("Unsupported receipt queue event type");
  }

  return {
    type: DELIVERY_RECEIPT_EVENT_TYPE,
    requestId: ensureNonBlankString(input.requestId, "requestId"),
    senderAgentDid: ensureNonBlankString(
      input.senderAgentDid,
      "senderAgentDid",
    ),
    recipientAgentDid: ensureNonBlankString(
      input.recipientAgentDid,
      "recipientAgentDid",
    ),
    status:
      input.status === "delivered_to_webhook" ||
      input.status === "dead_lettered"
        ? input.status
        : (() => {
            throw new Error("Unsupported receipt queue status");
          })(),
    reason:
      typeof input.reason === "string" && input.reason.trim().length > 0
        ? input.reason.trim()
        : undefined,
    processedAt:
      typeof input.processedAt === "string" &&
      input.processedAt.trim().length > 0
        ? input.processedAt.trim()
        : undefined,
  };
}

function resolveSenderRelaySession(input: {
  senderAgentDid: string;
  relaySessionNamespace: AgentRelaySessionNamespace;
}) {
  return input.relaySessionNamespace.get(
    input.relaySessionNamespace.idFromName(input.senderAgentDid),
  );
}

export async function handleReceiptQueueEvent(input: {
  event: ReceiptQueueEvent;
  relaySessionNamespace: AgentRelaySessionNamespace;
}): Promise<void> {
  const relaySession = resolveSenderRelaySession({
    senderAgentDid: input.event.senderAgentDid,
    relaySessionNamespace: input.relaySessionNamespace,
  });

  await recordRelayDeliveryReceipt(relaySession, {
    requestId: input.event.requestId,
    senderAgentDid: input.event.senderAgentDid,
    recipientAgentDid: input.event.recipientAgentDid,
    status: input.event.status,
    reason: input.event.reason,
  });
}
