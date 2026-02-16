export const AGENT_REGISTRATION_PROOF_VERSION = "clawdentity.register.v1";

export const AGENT_REGISTRATION_PROOF_MESSAGE_TEMPLATE =
  `${AGENT_REGISTRATION_PROOF_VERSION}\\n` +
  "challengeId:{challengeId}\\n" +
  "nonce:{nonce}\\n" +
  "ownerDid:{ownerDid}\\n" +
  "publicKey:{publicKey}\\n" +
  "name:{name}\\n" +
  "framework:{framework}\\n" +
  "ttlDays:{ttlDays}";

export type AgentRegistrationProofMessageInput = {
  challengeId: string;
  nonce: string;
  ownerDid: string;
  publicKey: string;
  name: string;
  framework?: string;
  ttlDays?: number;
};

function normalizeOptionalField(value: string | number | undefined): string {
  if (value === undefined) {
    return "";
  }

  return String(value);
}

export function canonicalizeAgentRegistrationProof(
  input: AgentRegistrationProofMessageInput,
): string {
  return [
    AGENT_REGISTRATION_PROOF_VERSION,
    `challengeId:${input.challengeId}`,
    `nonce:${input.nonce}`,
    `ownerDid:${input.ownerDid}`,
    `publicKey:${input.publicKey}`,
    `name:${input.name}`,
    `framework:${normalizeOptionalField(input.framework)}`,
    `ttlDays:${normalizeOptionalField(input.ttlDays)}`,
  ].join("\n");
}
