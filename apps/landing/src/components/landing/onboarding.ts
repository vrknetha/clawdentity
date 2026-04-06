export const CANONICAL_SKILL_URL = "https://clawdentity.com/skill.md";
const REGISTRY_URL =
  import.meta.env.PUBLIC_REGISTRY_URL ?? "https://registry.clawdentity.com";
export const GITHUB_ONBOARDING_START_URL = new URL(
  "/v1/onboarding/github/start",
  REGISTRY_URL,
).toString();

function shellQuote(value: string): string {
  return `'${value.replaceAll(`'`, `'"'"'`)}'`;
}

export function buildStarterPassPrompt(input: {
  code: string;
  displayName: string;
  agentName?: string;
}): string {
  const displayName = input.displayName.trim().replaceAll('"', '\\"');
  const agentName = input.agentName?.trim().replaceAll('"', '\\"');
  const agentInstruction =
    agentName && agentName.length > 0
      ? `Use agent name "${agentName}".`
      : "Ask me for the agent name if it is missing.";

  return [
    `Set up Clawdentity relay using ${CANONICAL_SKILL_URL} as the source of truth.`,
    "Run required onboarding end-to-end and execute commands directly.",
    "Auto-detect provider when possible; ask me only for missing required inputs.",
    `I already have a registry onboarding code: ${input.code.trim()}.`,
    `Use display name "${displayName}".`,
    agentInstruction,
    "This code is a GitHub starter pass, so create exactly one agent and stop after setup is complete.",
  ].join("\n");
}

export function buildStarterPassCommand(input: {
  code: string;
  displayName: string;
}): string {
  return `clawdentity invite redeem ${shellQuote(input.code.trim())} --display-name ${shellQuote(input.displayName.trim())}`;
}
