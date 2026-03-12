export function toPairKey(
  initiatorAgentDid: string,
  responderAgentDid: string,
): string {
  return [initiatorAgentDid, responderAgentDid].sort().join("|");
}

export function normalizeExpiryToWholeSecond(expiresAtMs: number): number {
  return Math.floor(expiresAtMs / 1000) * 1000;
}
