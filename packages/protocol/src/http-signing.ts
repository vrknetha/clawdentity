export const CLAW_PROOF_CANONICAL_VERSION = "CLAW-PROOF-V1";

export interface CanonicalRequestInput {
  method: string;
  pathWithQuery: string;
  timestamp: string;
  nonce: string;
  bodyHash: string;
}

export function canonicalizeRequest(input: CanonicalRequestInput): string {
  return [
    CLAW_PROOF_CANONICAL_VERSION,
    input.method.toUpperCase(),
    input.pathWithQuery,
    input.timestamp,
    input.nonce,
    input.bodyHash,
  ].join("\n");
}
