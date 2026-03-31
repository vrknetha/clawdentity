export type OpenclawSenderProfile = {
  agentName?: string;
  displayName?: string;
};

function sanitizeOptionalHeaderValue(
  value: string | undefined,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function applyOpenclawSenderProfileHeaders(input: {
  headers: Record<string, string>;
  senderProfile?: OpenclawSenderProfile;
}): void {
  const agentName = sanitizeOptionalHeaderValue(input.senderProfile?.agentName);
  const displayName = sanitizeOptionalHeaderValue(
    input.senderProfile?.displayName,
  );

  if (agentName !== undefined) {
    input.headers["x-clawdentity-agent-name"] = agentName;
  }
  if (displayName !== undefined) {
    input.headers["x-clawdentity-display-name"] = displayName;
  }
}
