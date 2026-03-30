import type {
  QueuedRelayDelivery,
  RelayDeliveryReceipt,
  RelayQueueState,
} from "./types.js";

export function isQueuedDelivery(value: unknown): value is QueuedRelayDelivery {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<QueuedRelayDelivery>;
  return (
    typeof candidate.deliveryId === "string" &&
    typeof candidate.requestId === "string" &&
    typeof candidate.senderAgentDid === "string" &&
    typeof candidate.recipientAgentDid === "string" &&
    (candidate.deliverySource === undefined ||
      typeof candidate.deliverySource === "string") &&
    (candidate.groupId === undefined ||
      typeof candidate.groupId === "string") &&
    (candidate.conversationId === undefined ||
      typeof candidate.conversationId === "string") &&
    (candidate.replyTo === undefined ||
      typeof candidate.replyTo === "string") &&
    typeof candidate.createdAtMs === "number" &&
    Number.isFinite(candidate.createdAtMs) &&
    typeof candidate.attemptCount === "number" &&
    Number.isInteger(candidate.attemptCount) &&
    candidate.attemptCount >= 0 &&
    typeof candidate.expiresAtMs === "number" &&
    Number.isFinite(candidate.expiresAtMs) &&
    typeof candidate.nextAttemptAtMs === "number" &&
    Number.isFinite(candidate.nextAttemptAtMs)
  );
}

export function normalizeReceipts(
  input: unknown,
): Record<string, RelayDeliveryReceipt> {
  if (typeof input !== "object" || input === null) {
    return {};
  }

  const normalized: Record<string, RelayDeliveryReceipt> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) {
      continue;
    }

    const receipt = value as Partial<RelayDeliveryReceipt>;
    if (
      typeof receipt.requestId !== "string" ||
      receipt.requestId !== key ||
      typeof receipt.deliveryId !== "string" ||
      typeof receipt.senderAgentDid !== "string" ||
      typeof receipt.recipientAgentDid !== "string" ||
      typeof receipt.expiresAtMs !== "number" ||
      !Number.isFinite(receipt.expiresAtMs) ||
      typeof receipt.statusUpdatedAt !== "string" ||
      !(
        receipt.state === "queued" ||
        receipt.state === "delivered" ||
        receipt.state === "processed_by_openclaw" ||
        receipt.state === "dead_lettered"
      )
    ) {
      continue;
    }

    normalized[key] = {
      requestId: receipt.requestId,
      deliveryId: receipt.deliveryId,
      expiresAtMs: receipt.expiresAtMs,
      senderAgentDid: receipt.senderAgentDid,
      recipientAgentDid: receipt.recipientAgentDid,
      state: receipt.state,
      reason: typeof receipt.reason === "string" ? receipt.reason : undefined,
      statusUpdatedAt: receipt.statusUpdatedAt,
    };
  }

  return normalized;
}

export function deleteQueuedReceipt(
  queueState: RelayQueueState,
  requestId: string,
  deliveryId: string,
): void {
  const receipt = queueState.receipts[requestId];
  if (receipt === undefined) {
    return;
  }

  if (receipt.deliveryId !== deliveryId || receipt.state !== "queued") {
    return;
  }

  delete queueState.receipts[requestId];
}

export function upsertReceipt(
  queueState: RelayQueueState,
  receipt: RelayDeliveryReceipt,
): void {
  queueState.receipts[receipt.requestId] = receipt;
}

export function pruneExpiredQueueState(
  queueState: RelayQueueState,
  nowMs: number,
): boolean {
  let mutated = false;

  const retainedDeliveries: QueuedRelayDelivery[] = [];
  for (const delivery of queueState.deliveries) {
    if (delivery.expiresAtMs <= nowMs) {
      deleteQueuedReceipt(queueState, delivery.requestId, delivery.deliveryId);
      mutated = true;
      continue;
    }

    retainedDeliveries.push(delivery);
  }

  if (retainedDeliveries.length !== queueState.deliveries.length) {
    queueState.deliveries = retainedDeliveries;
    mutated = true;
  }

  for (const [requestId, receipt] of Object.entries(queueState.receipts)) {
    if (receipt.expiresAtMs <= nowMs) {
      delete queueState.receipts[requestId];
      mutated = true;
    }
  }

  return mutated;
}

export function findNextQueueWakeMs(
  queueState: RelayQueueState,
  nowMs: number,
): number | undefined {
  let earliest: number | undefined;

  for (const delivery of queueState.deliveries) {
    const candidate = Math.max(nowMs + 1, delivery.nextAttemptAtMs);
    if (earliest === undefined || candidate < earliest) {
      earliest = candidate;
    }
  }

  return earliest;
}
