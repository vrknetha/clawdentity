import { encodeBase64url } from "@clawdentity/protocol";
import { buildTestAitClaims } from "@clawdentity/sdk/testing";

export function makeAitClaims(publicKey: Uint8Array) {
  return buildTestAitClaims({
    publicKeyX: encodeBase64url(publicKey),
    issuer: "https://registry.clawdentity.dev",
    nowSeconds: Math.floor(Date.now() / 1000),
    ttlSeconds: 3600,
    nbfSkewSeconds: 5,
    seedMs: 1_700_100_000_000,
    name: "agent-registry-01",
    framework: "openclaw",
    description: "registry key publishing verification path",
  });
}
