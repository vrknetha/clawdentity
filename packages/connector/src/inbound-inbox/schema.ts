import { nowIso } from "@clawdentity/sdk";
import { INBOUND_INBOX_SCHEMA_VERSION } from "./constants.js";
import type {
  ConnectorInboundDeadLetterItem,
  ConnectorInboundInboxItem,
  InboundInboxIndexFile,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseOptionalNonEmptyString(
  value: unknown,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parsePendingItem(
  value: unknown,
): ConnectorInboundInboxItem | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = parseOptionalNonEmptyString(value.id) ?? "";
  const requestId = parseOptionalNonEmptyString(value.requestId) ?? "";
  const fromAgentDid = parseOptionalNonEmptyString(value.fromAgentDid) ?? "";
  const toAgentDid = parseOptionalNonEmptyString(value.toAgentDid) ?? "";
  const receivedAt = parseOptionalNonEmptyString(value.receivedAt) ?? "";
  const nextAttemptAt = parseOptionalNonEmptyString(value.nextAttemptAt) ?? "";
  const attemptCount =
    typeof value.attemptCount === "number" &&
    Number.isInteger(value.attemptCount)
      ? value.attemptCount
      : NaN;
  const payloadBytes =
    typeof value.payloadBytes === "number" &&
    Number.isInteger(value.payloadBytes)
      ? value.payloadBytes
      : NaN;

  if (
    id.length === 0 ||
    requestId.length === 0 ||
    fromAgentDid.length === 0 ||
    toAgentDid.length === 0 ||
    receivedAt.length === 0 ||
    nextAttemptAt.length === 0 ||
    !Number.isFinite(attemptCount) ||
    attemptCount < 0 ||
    !Number.isFinite(payloadBytes) ||
    payloadBytes < 0
  ) {
    return undefined;
  }

  return {
    id,
    requestId,
    fromAgentDid,
    toAgentDid,
    payload: value.payload,
    payloadBytes,
    receivedAt,
    nextAttemptAt,
    attemptCount,
    lastError: parseOptionalNonEmptyString(value.lastError),
    lastAttemptAt: parseOptionalNonEmptyString(value.lastAttemptAt),
    conversationId: parseOptionalNonEmptyString(value.conversationId),
    replyTo: parseOptionalNonEmptyString(value.replyTo),
  };
}

function parseDeadLetterItem(
  value: unknown,
): ConnectorInboundDeadLetterItem | undefined {
  const pending = parsePendingItem(value);
  if (!pending || !isRecord(value)) {
    return undefined;
  }

  const deadLetteredAt =
    parseOptionalNonEmptyString(value.deadLetteredAt) ?? "";
  const deadLetterReason =
    parseOptionalNonEmptyString(value.deadLetterReason) ?? "";
  if (deadLetteredAt.length === 0 || deadLetterReason.length === 0) {
    return undefined;
  }

  return {
    ...pending,
    deadLetteredAt,
    deadLetterReason,
  };
}

export function toDefaultIndexFile(): InboundInboxIndexFile {
  return {
    version: INBOUND_INBOX_SCHEMA_VERSION,
    pendingBytes: 0,
    deadLetterBytes: 0,
    pendingByRequestId: {},
    deadLetterByRequestId: {},
    updatedAt: nowIso(),
  };
}

export function normalizeIndexFile(raw: unknown): InboundInboxIndexFile {
  if (!isRecord(raw)) {
    throw new Error("Inbound inbox index root must be an object");
  }

  if (raw.version !== INBOUND_INBOX_SCHEMA_VERSION) {
    throw new Error(
      `Inbound inbox index schema version ${String(raw.version)} is unsupported`,
    );
  }

  const pendingByRequestIdRaw = raw.pendingByRequestId;
  const deadLetterByRequestIdRaw = raw.deadLetterByRequestId;
  if (!isRecord(pendingByRequestIdRaw)) {
    throw new Error("Inbound inbox index pendingByRequestId must be an object");
  }
  if (!isRecord(deadLetterByRequestIdRaw)) {
    throw new Error(
      "Inbound inbox index deadLetterByRequestId must be an object",
    );
  }

  const pendingByRequestId: Record<string, ConnectorInboundInboxItem> = {};
  let pendingBytes = 0;
  for (const [requestId, candidate] of Object.entries(pendingByRequestIdRaw)) {
    const entry = parsePendingItem(candidate);
    if (!entry || entry.requestId !== requestId) {
      continue;
    }
    pendingByRequestId[requestId] = entry;
    pendingBytes += entry.payloadBytes;
  }

  const deadLetterByRequestId: Record<string, ConnectorInboundDeadLetterItem> =
    {};
  let deadLetterBytes = 0;
  for (const [requestId, candidate] of Object.entries(
    deadLetterByRequestIdRaw,
  )) {
    const entry = parseDeadLetterItem(candidate);
    if (!entry || entry.requestId !== requestId) {
      continue;
    }
    deadLetterByRequestId[requestId] = entry;
    deadLetterBytes += entry.payloadBytes;
  }

  return {
    version: INBOUND_INBOX_SCHEMA_VERSION,
    pendingByRequestId,
    deadLetterByRequestId,
    pendingBytes,
    deadLetterBytes,
    updatedAt: parseOptionalNonEmptyString(raw.updatedAt) ?? nowIso(),
  };
}
