import type { OpenclawSenderProfile } from "./openclaw-headers.js";

export type OpenclawHookPayloadInput = {
  conversationId?: string;
  groupId?: string;
  hookUrl: string;
  payload: unknown;
  replyTo?: string;
  requestId: string;
  senderDid: string;
  senderProfile?: OpenclawSenderProfile;
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

function extractMessage(payload: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }
  if (isRecord(payload)) {
    const content = parseOptionalNonEmptyString(payload.content);
    if (content !== undefined) {
      return content;
    }
    const message = parseOptionalNonEmptyString(payload.message);
    if (message !== undefined) {
      return message;
    }
    const text = parseOptionalNonEmptyString(payload.text);
    if (text !== undefined) {
      return text;
    }
  }

  return JSON.stringify(payload ?? null);
}

function resolveSenderAgentName(input: {
  payload: unknown;
  senderProfile?: OpenclawSenderProfile;
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
  senderProfile?: OpenclawSenderProfile;
}): string | undefined {
  return (
    parseOptionalNonEmptyString(input.senderProfile?.displayName) ??
    (isRecord(input.payload)
      ? parseOptionalNonEmptyString(input.payload.senderDisplayName)
      : undefined)
  );
}

function resolveGroupName(input: {
  groupId?: string;
  payload: unknown;
}): string | undefined {
  return (
    (isRecord(input.payload)
      ? parseOptionalNonEmptyString(input.payload.groupName)
      : undefined) ?? parseOptionalNonEmptyString(input.groupId)
  );
}

function renderSenderLabel(input: {
  senderAgentName?: string;
  senderDisplayName?: string;
  senderDid: string;
}): string {
  if (input.senderAgentName && input.senderDisplayName) {
    return `${input.senderAgentName} (${input.senderDisplayName})`;
  }

  return input.senderAgentName ?? input.senderDisplayName ?? input.senderDid;
}

function renderWakeText(input: {
  conversationId?: string;
  groupId?: string;
  groupName?: string;
  message: string;
  replyTo?: string;
  requestId: string;
  senderAgentName?: string;
  senderDid: string;
  senderDisplayName?: string;
}): string {
  const senderLabel = renderSenderLabel({
    senderAgentName: input.senderAgentName,
    senderDisplayName: input.senderDisplayName,
    senderDid: input.senderDid,
  });
  const isGroupMessage =
    parseOptionalNonEmptyString(input.groupId) !== undefined;
  const firstLine = isGroupMessage
    ? `Message in ${input.groupName ?? input.groupId} from ${senderLabel}`
    : `Message from ${senderLabel}`;
  const lines = [firstLine];

  if (input.message.trim().length > 0) {
    lines.push("", input.message);
  }

  lines.push("", `Request ID: ${input.requestId}`);
  if (parseOptionalNonEmptyString(input.conversationId)) {
    lines.push(`Conversation ID: ${input.conversationId}`);
  }
  if (parseOptionalNonEmptyString(input.replyTo)) {
    lines.push(`Reply To: ${input.replyTo}`);
  }

  return lines.join("\n");
}

export function buildOpenclawHookPayload(
  input: OpenclawHookPayloadInput,
): unknown {
  const hookPath = new URL(input.hookUrl).pathname;
  const message = extractMessage(input.payload);
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
    groupId,
    payload: input.payload,
  });
  const isGroupMessage = groupId !== undefined;

  if (hookPath === "/hooks/wake") {
    const wakeText = renderWakeText({
      conversationId: input.conversationId,
      groupId,
      groupName,
      message,
      replyTo: input.replyTo,
      requestId: input.requestId,
      senderAgentName,
      senderDid: input.senderDid,
      senderDisplayName,
    });
    const wakePayload: Record<string, unknown> = {
      message: wakeText,
      text: wakeText,
      mode: "now",
    };
    const sessionId = isRecord(input.payload)
      ? parseOptionalNonEmptyString(input.payload.sessionId)
      : undefined;
    if (sessionId) {
      wakePayload.sessionId = sessionId;
    }

    return wakePayload;
  }

  return {
    message,
    senderDid: input.senderDid,
    senderAgentName: senderAgentName ?? null,
    senderDisplayName: senderDisplayName ?? null,
    recipientDid: input.toAgentDid,
    groupId: groupId ?? null,
    groupName: groupName ?? null,
    isGroupMessage,
    requestId: input.requestId,
    metadata: {
      conversationId: input.conversationId ?? null,
      replyTo: input.replyTo ?? null,
      payload: input.payload ?? null,
    },
  };
}
