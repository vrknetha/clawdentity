export type OpenclawSenderProfile = {
  agentName?: string;
  humanName?: string;
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
  const humanName = sanitizeOptionalHeaderValue(input.senderProfile?.humanName);

  if (agentName !== undefined) {
    input.headers["x-clawdentity-agent-name"] = agentName;
  }
  if (humanName !== undefined) {
    input.headers["x-clawdentity-human-name"] = humanName;
  }
}
