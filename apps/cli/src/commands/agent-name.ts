import { validateAgentName } from "@clawdentity/protocol";

const RESERVED_AGENT_NAMES = new Set([".", ".."]);

export const assertValidAgentName = (name: string): string => {
  const normalizedName = name.trim();

  if (RESERVED_AGENT_NAMES.has(normalizedName)) {
    throw new Error('Agent name must not be "." or "..".');
  }

  if (!validateAgentName(normalizedName)) {
    throw new Error(
      "Agent name contains invalid characters, reserved path segments, or length. Use 1-64 chars: a-z, A-Z, 0-9, ., _, -",
    );
  }

  return normalizedName;
};
