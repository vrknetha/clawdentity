import { parseOptionalNonEmptyString } from "./parse.js";
import type {
  ConnectorInboundDeadLetterItem,
  ConnectorInboundInboxItem,
  InboundInboxEvent,
} from "./types.js";

type PendingRow = {
  attempt_count: number;
  conversation_id: string | null;
  from_agent_did: string;
  group_id: string | null;
  id: string;
  last_attempt_at: string | null;
  last_error: string | null;
  next_attempt_at: string;
  payload: string;
  payload_bytes: number;
  received_at: string;
  reply_to: string | null;
  request_id: string;
  to_agent_did: string;
};

type DeadLetterRow = PendingRow & {
  dead_letter_reason: string;
  dead_lettered_at: string;
};

type EventRow = {
  details: string | null;
  request_id: string | null;
  type: InboundInboxEvent["type"];
};

function parseJsonPayload(raw: string): unknown {
  return JSON.parse(raw) as unknown;
}

export function serializePayload(payload: unknown): string {
  return JSON.stringify(payload ?? null);
}

export function serializeEventDetails(
  details: InboundInboxEvent["details"],
): string | null {
  if (details === undefined) {
    return null;
  }
  return JSON.stringify(details);
}

export function toPendingRow(item: ConnectorInboundInboxItem): PendingRow {
  return {
    id: item.id,
    request_id: item.requestId,
    from_agent_did: item.fromAgentDid,
    to_agent_did: item.toAgentDid,
    group_id: item.groupId ?? null,
    conversation_id: item.conversationId ?? null,
    reply_to: item.replyTo ?? null,
    payload: serializePayload(item.payload),
    payload_bytes: item.payloadBytes,
    received_at: item.receivedAt,
    next_attempt_at: item.nextAttemptAt,
    attempt_count: item.attemptCount,
    last_attempt_at: item.lastAttemptAt ?? null,
    last_error: item.lastError ?? null,
  };
}

export function toPendingItem(row: PendingRow): ConnectorInboundInboxItem {
  return {
    id: row.id,
    requestId: row.request_id,
    fromAgentDid: row.from_agent_did,
    toAgentDid: row.to_agent_did,
    groupId: parseOptionalNonEmptyString(row.group_id),
    conversationId: parseOptionalNonEmptyString(row.conversation_id),
    replyTo: parseOptionalNonEmptyString(row.reply_to),
    payload: parseJsonPayload(row.payload),
    payloadBytes: row.payload_bytes,
    receivedAt: row.received_at,
    nextAttemptAt: row.next_attempt_at,
    attemptCount: row.attempt_count,
    lastAttemptAt: parseOptionalNonEmptyString(row.last_attempt_at),
    lastError: parseOptionalNonEmptyString(row.last_error),
  };
}

export function toDeadLetterRow(
  item: ConnectorInboundDeadLetterItem,
): DeadLetterRow {
  return {
    ...toPendingRow(item),
    dead_lettered_at: item.deadLetteredAt,
    dead_letter_reason: item.deadLetterReason,
  };
}

export function toDeadLetterItem(
  row: DeadLetterRow,
): ConnectorInboundDeadLetterItem {
  return {
    ...toPendingItem(row),
    deadLetteredAt: row.dead_lettered_at,
    deadLetterReason: row.dead_letter_reason,
  };
}

export function toEventRow(event: InboundInboxEvent): EventRow {
  return {
    type: event.type,
    request_id: event.requestId ?? null,
    details: serializeEventDetails(event.details),
  };
}
